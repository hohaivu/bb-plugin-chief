/**
 * Backlog board panel for Chief. The Kanban board, task card, task modal, filter controls and
 * Markdown rendering are adapted from https://github.com/StreamlinedStartup/bb-plugin-backlog
 * (commit 7f5235e), MIT License, Copyright (c) 2026 StreamlinedStartup; see LICENSE-bb-plugin-backlog.
 * Chief's additions: the off / no-folder / ambiguous states, read-only thread and PR chips, a
 * project picker, an archive button (no delete) and a one-line "new task" form.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, Dispatch, KeyboardEvent, SetStateAction } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import {
  experimental_ProviderIcon as ProviderIcon,
  experimental_useProviders as useProviders,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { BacklogBoard, BacklogLink, BoardTask, Edit, FieldValue, Task } from "./backlog";
import type { rpcContract } from "./server";
import "./backlog.css";

const textError = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const STORAGE = { active: "Active tasks", completed: "Completed storage", archived: "Archived tasks", all: "All storage" };

// ---- task-format labels (adapted from src/task-format.ts) ----
const fieldLabels: Record<string, string> = {
  title: "Title", status: "Status", type: "Type", priority: "Priority", assignee: "Assignees", reporter: "Reporter", labels: "Labels", milestone: "Milestone", due_date: "Due date", project: "Project classification", dependencies: "Dependencies", references: "References", documentation: "Documentation", modified_files: "Modified files", ordinal: "Order", chief_after: "Wait condition",
};
const listFields = new Set(["assignee", "labels", "dependencies", "references", "documentation", "modified_files"]);
const editableSectionLabels: Record<string, string> = {
  description: "Description", "acceptance criteria": "Acceptance Criteria", "definition of done": "Definition of Done", "implementation plan": "Implementation Plan", "implementation notes": "Implementation Notes", "final summary": "Final Summary",
};

// ---- task-relations (adapted from src/task-relations.ts) ----
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function childTasks(parent: Task, tasks: Task[]): Task[] {
  const explicit = Array.isArray(parent.fields.subtasks) ? parent.fields.subtasks.map(String) : [];
  return tasks.filter(task => {
    if (sameId(task.id, parent.id)) return false;
    if (sameId(String(task.fields.parent_task_id ?? ""), parent.id)) return true;
    if (explicit.some(id => sameId(id, task.id))) return true;
    const prefix = `${parent.id.toLowerCase()}.`;
    return task.id.toLowerCase().startsWith(prefix) && !task.id.slice(prefix.length).includes(".");
  });
}
function parentTask(task: Task, tasks: Task[]): Task | undefined {
  const id = typeof task.fields.parent_task_id === "string" ? task.fields.parent_task_id : task.id.includes(".") ? task.id.slice(0, task.id.lastIndexOf(".")) : null;
  return id ? tasks.find(candidate => sameId(candidate.id, id)) : tasks.find(candidate => Array.isArray(candidate.fields.subtasks) && candidate.fields.subtasks.some(sub => sameId(String(sub), task.id)));
}
function descriptionPreview(task: Task): string {
  return (task.sections.description ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|>\s*)/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ").trim().slice(0, 420);
}
const assignees = (task: Task): string[] => Array.isArray(task.fields.assignee) ? task.fields.assignee.map(String) : task.fields.assignee ? [String(task.fields.assignee)] : [];
const initials = (name: string) => Array.from(name.trim().replace(/^@/, "")).slice(0, 2).join("").toUpperCase();
function assigneeProvider(name: string): "codex" | "claude-code" | null {
  const normalized = name.trim().replace(/^@/, "").toLowerCase().replace(/[\s_-]+/g, "");
  return normalized === "codex" ? "codex" : normalized === "claude" || normalized === "claudecode" ? "claude-code" : null;
}

// ---- board-controls (adapted from src/board-controls.ts) ----
type SortMode = "ordinal" | "title" | "priority" | "due_date" | "created_date" | "updated_date";
type SortDirection = "asc" | "desc";
type BoardFilters = { status: string[]; priority: string[]; assignee: string; labels: string[]; sort: SortMode; direction: SortDirection };
const EMPTY_FILTERS: BoardFilters = { status: [], priority: [], assignee: "", labels: [], sort: "ordinal", direction: "asc" };
const text = (value: unknown) => String(value ?? "").trim();
const compareText = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
const priorityRank = (value: string) => ({ high: 0, medium: 1, low: 2 }[value.toLowerCase()] ?? 3);
const fieldValues = (task: Task, key: "labels" | "assignee") => { const value = task.fields[key]; return Array.isArray(value) ? value.map(text).filter(Boolean) : value ? [text(value)] : []; };
function matchesBoardFilters(task: Task, filters: BoardFilters) {
  if (filters.status.length && !filters.status.includes(task.status)) return false;
  if (filters.priority.length && !filters.priority.includes(text(task.fields.priority))) return false;
  if (filters.assignee && !assignees(task).map(text).includes(filters.assignee)) return false;
  const labels = new Set(fieldValues(task, "labels"));
  return filters.labels.every(label => labels.has(label));
}
function compareBoardTasks(a: Task, b: Task, mode: SortMode, direction: SortDirection) {
  const dateKey = mode === "created_date" || mode === "updated_date" ? mode : null;
  const value = (task: Task) => mode === "title" ? task.title : mode === "priority" ? text(task.fields.priority) : mode === "due_date" ? text(task.fields.due_date) : dateKey ? text(task.fields[dateKey]) : task.ordinal === null ? "" : String(task.ordinal);
  const valueA = value(a), valueB = value(b);
  if (!valueA !== !valueB) return !valueA ? 1 : -1;
  let result = mode === "priority" ? priorityRank(valueA) - priorityRank(valueB) || compareText(valueA, valueB) : mode === "ordinal" ? Number(valueA) - Number(valueB) : compareText(valueA, valueB);
  if (direction === "desc") result *= -1;
  return result || compareText(a.id, b.id) || compareText(a.path, b.path);
}
const selectBoardTasks = <T extends Task>(tasks: T[], filters: BoardFilters) => tasks.filter(task => matchesBoardFilters(task, filters)).sort((a, b) => compareBoardTasks(a, b, filters.sort, filters.direction));

// ---- AssigneeAvatar / Markdown (adapted) ----
function AgentMark({ id, name }: { id: string; name: string }) {
  const { providers } = useProviders();
  const provider = providers.find(candidate => candidate.id === id);
  return provider ? <ProviderIcon providerKind="agent" provider={provider} className="assignee-provider-icon" aria-hidden="true" /> : <>{initials(name)}</>;
}
function AssigneeAvatar({ name }: { name: string }) {
  const provider = assigneeProvider(name);
  return <span className="person-avatar" title={name} aria-label={name}>{provider ? <AgentMark id={provider} name={name} /> : initials(name)}</span>;
}
function Markdown({ children, onEditSection, editable = [] }: { children: string; onEditSection?: (key: string) => void; editable?: string[] }) {
  return <div className="markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{
    a: ({ children: label, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{label}</a>,
    img: ({ alt }) => <span className="image-placeholder">Image: {alt || "Untitled"}</span>,
    h2: ({ children: label }) => {
      const key = String(label).replace(/\s*\(Optional\)$/i, "").toLowerCase();
      const canEdit = onEditSection && editable.includes(key);
      return <h2 role={canEdit ? "button" : undefined} tabIndex={canEdit ? 0 : undefined} aria-label={canEdit ? `Edit ${key}` : undefined} onKeyDown={event => { if (canEdit && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onEditSection(key); } }} onDoubleClick={() => canEdit && onEditSection(key)}>{label}</h2>;
    },
  }}>{children || "_No content yet._"}</ReactMarkdown></div>;
}

// ---- Chief: read-only thread / PR chips ----
function LinkChips({ task }: { task: BoardTask }) {
  if (!task.links.length && !task.after) return null;
  return <div className="link-chips">
    {task.after && <span className="after-chip" title="Wait condition">after: {task.after}</span>}
    {task.links.map((link: BacklogLink) => <span className="link-chip" key={link.threadId} title={`${link.role} thread: ${link.title}`}>{link.role} · {link.state}</span>)}
    {task.links.filter(link => link.prUrl).map(link => <a className="link-chip" key={`pr-${link.threadId}`} href={link.prUrl!} target="_blank" rel="noopener noreferrer" onClick={event => event.stopPropagation()}>PR</a>)}
  </div>;
}

// ---- TaskCard (adapted from src/TaskCard.tsx) ----
function TaskCard({ task, statuses, open, start, move, before, after, subtaskCount = 0 }: {
  task: BoardTask; statuses: string[]; open: () => void; start: (event: DragEvent) => void;
  move: (status: string, before: string | null) => void; before: string | null; after: string | null; subtaskCount?: number;
}) {
  const people = assignees(task);
  const preview = descriptionPreview(task);
  const percent = task.progress.total ? Math.round(task.progress.done / task.progress.total * 100) : 0;
  const priority = String(task.fields.priority ?? "");
  return <article className="task-card" draggable onDragStart={start} tabIndex={0} aria-describedby="backlog-keyboard-help" aria-label={`${task.id}: ${task.title}`} onClick={open} onKeyDown={event => {
    if (event.target !== event.currentTarget) return;
    if (event.altKey && event.key.startsWith("Arrow")) {
      event.preventDefault();
      const index = statuses.indexOf(task.status);
      if (event.key === "ArrowLeft" && index > 0) move(statuses[index - 1]!, null);
      if (event.key === "ArrowRight" && index < statuses.length - 1) move(statuses[index + 1]!, null);
      if (event.key === "ArrowUp" && before) move(task.status, before);
      if (event.key === "ArrowDown" && after !== task.path) move(task.status, after);
    } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
  }}>
    <div className="card-top"><span className="task-id">{task.id}</span>{priority && <span className="priority-badge" data-priority={priority.toLowerCase()}>{priority}</span>}</div>
    <h3>{task.title}</h3>
    {preview && <p className="card-description">{preview}</p>}
    {Array.isArray(task.fields.labels) && task.fields.labels.length > 0 && <div className="card-tags">{task.fields.labels.map((label, index) => <span key={index}>{String(label)}</span>)}</div>}
    <div className="card-progress"><div><span>{task.progress.total ? "Checklist" : "No checklist"}</span><span>{task.progress.total ? `${task.progress.done}/${task.progress.total} (${percent}%)` : ""}</span></div><progress aria-label={`${task.id} checklist progress`} value={task.progress.done} max={task.progress.total || 1} /></div>
    <div className="card-footer"><div className="card-people" title={people.join(", ")}>{people.length ? <><span className="avatar-stack">{people.slice(0, 2).map(person => <AssigneeAvatar key={person} name={person} />)}</span><span className="assignee-name">{people.length === 1 ? people[0] : `${people.length} assignees`}</span></> : <span>Unassigned</span>}</div>{subtaskCount > 0 && <span className="subtask-count">{subtaskCount} {subtaskCount === 1 ? "subtask" : "subtasks"}</span>}</div>
    <LinkChips task={task} />
    {task.errors.length > 0 && <div className="card-issue" title={task.errors.join(" ")}>Needs attention</div>}
  </article>;
}

// ---- BoardControls (adapted from src/BoardControls.tsx) ----
type FilterOptions = { statuses: string[]; priorities: string[]; assignees: string[]; labels: string[] };
function FilterMenu({ label, values, selected, onChange }: { label: string; values: string[]; selected: string[]; onChange: (value: string, checked: boolean) => void }) {
  return <details className="filter-menu"><summary className="filter-trigger">{label}{selected.length > 0 && <span className="filter-count">{selected.length}</span>}</summary><div className="filter-popover">{values.length ? values.map(value => <label className="filter-option" key={value}><input type="checkbox" aria-label={`${label} ${value || "No status"}`} checked={selected.includes(value)} onChange={event => onChange(value, event.target.checked)} />{value || "No status"}</label>) : <span className="filter-empty">No options</span>}</div></details>;
}
function BoardControls({ filters, options, setFilters }: { filters: BoardFilters; options: FilterOptions; setFilters: Dispatch<SetStateAction<BoardFilters>> }) {
  const toggle = (key: "status" | "priority" | "labels", value: string, checked: boolean) => setFilters(current => ({ ...current, [key]: checked ? [...current[key], value] : current[key].filter(item => item !== value) }));
  const active = filters.status.length > 0 || filters.priority.length > 0 || filters.assignee.length > 0 || filters.labels.length > 0 || filters.sort !== "ordinal" || filters.direction !== "asc";
  return <div className="board-filters" role="group" aria-label="Board filters"><span className="board-filters-label">Filter by</span>
    <FilterMenu label="Status" values={options.statuses} selected={filters.status} onChange={(value, checked) => toggle("status", value, checked)} />
    <FilterMenu label="Priority" values={options.priorities} selected={filters.priority} onChange={(value, checked) => toggle("priority", value, checked)} />
    <FilterMenu label="Assignee" values={options.assignees} selected={filters.assignee ? [filters.assignee] : []} onChange={(value, checked) => setFilters(current => ({ ...current, assignee: checked ? value : "" }))} />
    <FilterMenu label="Labels" values={options.labels} selected={filters.labels} onChange={(value, checked) => toggle("labels", value, checked)} />
    <label className="sort-control">Sort by<select aria-label="Sort tasks" value={filters.sort} onChange={event => setFilters(current => ({ ...current, sort: event.target.value as SortMode }))}><option value="ordinal">Ordinal</option><option value="title">Title</option><option value="priority">Priority</option><option value="due_date">Due date</option><option value="created_date">Date created</option><option value="updated_date">Date updated</option></select><select aria-label="Sort direction" value={filters.direction} onChange={event => setFilters(current => ({ ...current, direction: event.target.value as SortDirection }))}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
    <button className="reset-filters" type="button" onClick={() => setFilters(EMPTY_FILTERS)} disabled={!active}>Reset</button>
  </div>;
}

// ---- TaskModal (adapted from src/TaskModal.tsx; quoting is dropped, archive is added) ----
type SaveResult = { task: Task; conflict: boolean; message: string };
const display = (value: unknown) => {
  if (value === null || value === undefined || value === "") return "Not set";
  if (Array.isArray(value)) return value.join(", ") || "Not set";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
};
const inputValue = (value: unknown) => {
  if (Array.isArray(value)) return value.join("\n");
  if (value === null || value === undefined) return "";
  return String(value);
};
const pathKeys = new Set(["references", "documentation", "modified_files"]);
const valueList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value === null || value === undefined || value === "") return [];
  return [String(value)];
};
const shortenPath = (value: string) => {
  if (value.length <= 44 || !value.includes("/")) return value;
  const parts = value.split("/").filter(Boolean);
  return parts.length > 1 ? `…/${parts.slice(-2).join("/")}` : `…${value.slice(-41)}`;
};
const stateValue = (value: unknown) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
function PropertyList({ name, value }: { name: string; value: unknown }) {
  const values = valueList(value);
  if (!values.length) return <>Not set</>;
  return <span className="property-list">{values.map((item, index) => {
    const isPath = pathKeys.has(name) || item.includes("/");
    const label = isPath ? shortenPath(item) : item;
    const pathProps = isPath ? { title: item, "aria-label": item } : {};
    return <span className="property-chip" key={`${item}-${index}`} {...pathProps}>{label}</span>;
  })}</span>;
}
const propertyIcons: Record<string, string> = {
  status: "M4 7h16M4 12h10M4 17h16",
  type: "M4 5h16v14H4z",
  priority: "M12 4l2.2 4.7 5.2.8-3.7 3.7.9 5.2-4.6-2.5-4.6 2.5.9-5.2-3.7-3.7 5.2-.8z",
  assignee: "M12 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 7a6 6 0 0 1 12 0",
  reporter: "M12 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 7a6 6 0 0 1 12 0",
  labels: "M4 5h8l8 7-8 7H4z",
  milestone: "M5 19V5m0 0h12l-2 4 2 4H5",
  due_date: "M5 7h14v12H5zM8 4v6m8-6v6M5 11h14",
  project: "M4 7h6l2 2h8v10H4z",
  dependencies: "M8 12h8M10 8h2a4 4 0 0 1 0 8h-2M14 8h-2a4 4 0 0 0 0 8h2",
  references: "M5 5h14v14H5zM8 9h8M8 13h5",
  documentation: "M5 4h14v16H5zM8 8h8M8 12h8M8 16h5",
  modified_files: "M5 4h14v16H5zM8 8h8M8 12h5",
  created_date: "M5 5h14v14H5zM8 3v4m8-4v4M5 10h14",
  updated_date: "M5 5h14v14H5zM8 3v4m8-4v4M5 10h14M12 13v3l2 1",
};
function PropertyIcon({ name }: { name: string }) {
  return <svg className="property-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={propertyIcons[name] ?? propertyIcons.documentation} /></svg>;
}
interface Draft { kind: "field" | "section"; key: string; before: FieldValue; text: string; revision?: string }
function restoreDraft(key: string): { draft: Draft | null; recovery: string | null; message: string } {
  let stored: string | null = null;
  try {
    stored = sessionStorage.getItem(key);
    if (!stored) return { draft: null, recovery: null, message: "" };
    const candidate = JSON.parse(stored);
    if ((candidate.kind !== "field" && candidate.kind !== "section") || typeof candidate.key !== "string" || typeof candidate.text !== "string") throw new Error("Unrecognized draft format");
    const revision = typeof candidate.revision === "string" ? candidate.revision : undefined;
    return { draft: { kind: candidate.kind, key: candidate.key, before: candidate.before ?? null, text: candidate.text, revision }, recovery: null, message: "Recovered your unsaved draft from this browser session." };
  } catch {
    return { draft: null, recovery: stored, message: "Saved draft storage could not be read. Any stored text is retained below for recovery." };
  }
}
interface TaskModalProps {
  task: BoardTask;
  draftStorageKey?: string;
  statuses: string[];
  relatedTasks?: Task[];
  onOpenTask?: (task: Task) => void;
  fieldChoices?: Record<string, string[]>;
  missing?: boolean;
  onClose: () => void;
  onSave: (edits: Edit[], baseRevision?: string) => Promise<SaveResult>;
  onArchive: () => Promise<void>;
}
function TaskModal({ task, statuses, relatedTasks = [], onOpenTask, fieldChoices = {}, draftStorageKey = task.path, missing = false, onClose, onSave, onArchive }: TaskModalProps) {
  const [current, setCurrent] = useState(task);
  const storageKey = `chief-backlog-draft:${draftStorageKey}`;
  const [restored] = useState(() => restoreDraft(storageKey));
  const [recovery, setRecovery] = useState(restored.recovery);
  const [draft, setDraft] = useState<Draft | null>(restored.draft);
  const [error, setError] = useState(restored.message);
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft); draftRef.current = draft;
  useEffect(() => { setCurrent(task); }, [task]);
  useEffect(() => {
    try { if (draft) sessionStorage.setItem(storageKey, JSON.stringify(draft)); else if (!recovery) sessionStorage.removeItem(storageKey); }
    catch { if (draft) setError("This browser cannot retain drafts across page reloads. Keep this task open until you save or cancel."); }
  }, [draft, storageKey, recovery]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (draftRef.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => { element.close(); previous?.focus(); };
  }, []);
  useEffect(() => { if (draft) editor.current?.focus(); }, [draft?.kind, draft?.key]);
  const start = (kind: Draft["kind"], key: string) => {
    if (recovery) { setError("Copy the saved draft below, then explicitly discard it before starting another edit."); return; }
    if (draft || pending) { setError("Save or cancel the active edit first."); return; }
    const value = kind === "field" ? current.fields[key] ?? null : current.sections[key] ?? null;
    setDraft({ kind, key, before: value as FieldValue, text: inputValue(value), revision: current.revision });
    setConflict(false); setError("");
  };
  const cancel = () => { if (pending) return; setDraft(null); setConflict(false); setError(""); };
  const close = () => { if (draftRef.current || pending) { setError("Save or cancel your edit before closing this task."); return; } onClose(); };
  const save = async () => {
    const activeDraft = draft;
    if (!activeDraft || pending) return;
    setPending(true); setError("");
    try {
      let value: FieldValue;
      if (activeDraft.kind === "section") value = activeDraft.text;
      else if (listFields.has(activeDraft.key)) value = activeDraft.text.split("\n").map(s => s.trim()).filter(Boolean);
      else value = activeDraft.text || null;
      const result = await onSave([{ kind: activeDraft.kind, key: activeDraft.key, before: activeDraft.before, value }], activeDraft.revision);
      setCurrent(previous => ({ ...previous, ...result.task }));
      if (result.conflict) { setConflict(true); setError(result.message); }
      else { setDraft(null); setConflict(false); }
    } catch (cause) { setError(textError(cause)); }
    finally { setPending(false); }
  };
  const archive = async () => {
    if (draft || pending) { setError("Save or cancel your edit before archiving."); return; }
    setPending(true); setError("");
    try { await onArchive(); } catch (cause) { setError(textError(cause)); setPending(false); }
  };
  const rebase = () => {
    setDraft(activeDraft => {
      if (!activeDraft) return activeDraft;
      const value = activeDraft.kind === "field" ? current.fields[activeDraft.key] ?? null : current.sections[activeDraft.key] ?? null;
      return { ...activeDraft, before: value as FieldValue, revision: current.revision };
    });
    setConflict(false); setError("Draft kept. Save changes to replace the current value shown above.");
  };
  const editableSections = Object.keys(editableSectionLabels);
  const missingSections = editableSections.filter(key => !(key in current.sections));
  const children = childTasks(current, relatedTasks);
  const parent = parentTask(current, relatedTasks);
  const doneChildren = children.filter(child => child.status === statuses.at(-1)).length;
  const properties = [...Object.entries(fieldLabels).filter(([key]) => key !== "title" && key !== "ordinal"), ["created_date", "Created"], ["updated_date", "Updated"]] as Array<[string, string]>;
  const primaryKeys = new Set(["status", "priority", "assignee", "due_date"]);
  const primaryProperties = properties.filter(([key]) => primaryKeys.has(key));
  const secondaryProperties = properties.filter(([key]) => !primaryKeys.has(key) && valueList(current.fields[key]).length > 0);
  const isReadOnlyProperty = (key: string) => key === "created_date" || key === "updated_date";
  const openRelated = (related: Task) => {
    if (draft || pending || recovery) { setError("Save or cancel your edit before opening another task."); return; }
    onOpenTask?.(related);
  };
  const activateEdit = (event: KeyboardEvent, key: string) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); start("field", key); }
  };
  const readOnly = missing || current.errors.length > 0 || current.storage === "archived";
  const renderFieldEditor = (key: string, label: string) => {
    if (!draft || draft.kind !== "field" || draft.key !== key) return null;
    const choices = key === "status" ? statuses : fieldChoices[key];
    const update = (value: string) => setDraft({ ...draft, text: value });
    let control: React.ReactNode;
    if (choices) {
      control = <select aria-label={`${label} draft`} value={draft.text} onChange={event => update(event.target.value)}>{key !== "status" && <option value="">Not set</option>}{!choices.includes(draft.text) && draft.text && <option>{draft.text}</option>}{choices.map(value => <option key={value}>{value}</option>)}</select>;
    } else if (key === "due_date") {
      control = <input type="date" aria-label="Due date draft" value={draft.text.slice(0, 10)} onChange={event => update(event.target.value)} />;
    } else {
      control = <textarea ref={editor} aria-label="Draft" rows={listFields.has(key) ? 4 : 2} value={draft.text} onChange={event => update(event.target.value)} />;
    }
    return <div className="inline-field-editor" aria-label={`Editing ${label.toLowerCase()}`}>
      {control}
      {listFields.has(key) && <small>One value per line.</small>}
      {conflict && <div className="conflict"><h4>Current file value</h4><pre>{display(current.fields[key])}</pre><p>Your draft remains in the editor above.</p><button onClick={rebase}>Use my draft over this value</button></div>}
      <div className="modal-actions"><button className="primary" onClick={() => void save()} disabled={pending || conflict || readOnly}>{pending ? "Saving..." : "Save changes"}</button><button disabled={pending} onClick={cancel}>Cancel edit</button></div>
    </div>;
  };
  const renderProperty = ([key, label]: [string, string]) => {
    const locked = isReadOnlyProperty(key);
    const value = current.fields[key];
    const stateClass = key === "status" || key === "priority" ? `property-value-${key}` : "";
    let renderedValue: React.ReactNode = display(value);
    if (key === "assignee" && assignees(current).length) renderedValue = <span className="detail-assignees">{assignees(current).map(person => <span key={person}><AssigneeAvatar name={person} />{person}</span>)}</span>;
    else if (listFields.has(key)) renderedValue = <PropertyList name={key} value={value} />;
    else if (key === "status" || key === "priority") renderedValue = <span className={`property-badge ${stateClass}`} data-state={stateValue(value)}>{display(value)}</span>;
    const editing = draft?.kind === "field" && draft.key === key;
    const editable = !locked;
    return <div className={`detail-property${locked ? " read-only" : ""}${editing ? " editing" : ""}`} data-editable={editable ? "true" : undefined} key={key} role={editable && !editing ? "button" : undefined} tabIndex={editable && !editing ? 0 : undefined} aria-label={editable && !editing ? `Edit ${label.toLowerCase()}` : undefined} onKeyDown={editable && !editing ? event => activateEdit(event, key) : undefined} onDoubleClick={editable && !editing ? () => start("field", key) : undefined}><dt><PropertyIcon name={key} /><span>{label}</span></dt><dd className="property-value">{editing ? renderFieldEditor(key, label) : renderedValue}</dd></div>;
  };
  return <dialog ref={dialog} className="backlog-modal" aria-labelledby="task-modal-title" onCancel={event => { event.preventDefault(); if (pending) return; if (draft) cancel(); else onClose(); }}>
    <div className="task-modal">
      <header className="modal-header"><div><span className="task-id">{current.id} / {current.storage}</span><h2 id="task-modal-title" role={draft?.kind === "field" && draft.key === "title" ? undefined : "button"} tabIndex={draft?.kind === "field" && draft.key === "title" ? undefined : 0} aria-label={draft?.kind === "field" && draft.key === "title" ? undefined : "Edit title"} onKeyDown={event => activateEdit(event, "title")} onDoubleClick={() => start("field", "title")}>{draft?.kind === "field" && draft.key === "title" ? renderFieldEditor("title", "Title") : current.title}</h2></div><div>{current.storage !== "archived" && <button disabled={pending || missing} onClick={() => void archive()}>Archive</button>} <button onClick={close} aria-label="Close task">Close</button></div></header>
      {recovery && <section className="notice error"><h3>Saved draft recovery</h3><pre>{recovery}</pre><button onClick={() => setRecovery(null)}>Discard unreadable saved draft</button></section>}
      {missing && <p role="alert" className="notice error">This task is no longer in the current snapshot. Your draft is still here. Check whether the file moved or the source is unavailable.</p>}
      {current.errors.map((message, i) => <p className="notice error" key={i}>{message}</p>)}
      <div className="task-layout">
        <main className="task-content-column">
          {draft?.kind === "section" && <section className="field-editor" aria-label="Active edit">
            <div className="editor-heading"><h3>Editing {fieldLabels[draft.key] ?? editableSectionLabels[draft.key] ?? draft.key}</h3><span>Draft stays here until Save or Cancel</span></div>
            <textarea ref={editor} aria-label="Draft" rows={10} value={draft.text} onChange={e => setDraft({ ...draft, text: e.target.value })} />
            {conflict && <div className="conflict"><h4>Current file value</h4><pre>{display(current.sections[draft.key])}</pre><p>Your draft remains in the editor above.</p><button onClick={rebase}>Use my draft over this value</button></div>}
            <div className="modal-actions"><button className="primary" onClick={() => void save()} disabled={pending || conflict || readOnly}>{pending ? "Saving..." : "Save changes"}</button><button disabled={pending} onClick={cancel}>Cancel edit</button></div>
          </section>}
          {error && <p className="notice error" role="alert">{error}</p>}
          <LinkChips task={task} />
          <section className="modal-content" aria-label="Task content"><Markdown onEditSection={key => start("section", key)} editable={editableSections}>{current.body}</Markdown></section>
          {parent && <button className="parent-task-link" onClick={() => openRelated(parent)}>Parent task <span>{parent.id}</span> {parent.title}</button>}
          {children.length > 0 && <section className="subtasks-panel" aria-label="Subtasks">
            <header><h3>Subtasks <span>{children.length}</span></h3><div><span>{doneChildren} of {children.length} complete</span><progress aria-label="Subtasks completion" value={doneChildren} max={children.length} /></div></header>
            <div className="subtask-list">{children.map(child => {
              const person = assignees(child)[0]; const done = child.status === statuses.at(-1);
              return <button className="subtask-row" key={child.path} onClick={() => openRelated(child)}>
                <span className={done ? "subtask-check checked" : "subtask-check"} aria-label={done ? "Complete" : "Not complete"}>{done && <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7" /></svg>}</span>
                <span className="subtask-identity"><span>{child.id}</span><strong>{child.title}</strong></span>
                <span className="subtask-status" data-done={done}>{child.status || "No status"}</span>
                {person && <AssigneeAvatar name={person} />}
              </button>;
            })}</div>
          </section>}
          {missingSections.length > 0 && <div className="section-tools"><label>Add section<select aria-label="Add task section" value="" onChange={e => { if (e.target.value) start("section", e.target.value); }}><option value="">Choose section</option>{missingSections.map(key => <option key={key} value={key}>{editableSectionLabels[key] ?? key}</option>)}</select></label></div>}
        </main>
        <aside className="task-properties" aria-label="Task properties">
          <dl className="primary-summary" aria-label="Task summary">{primaryProperties.map(renderProperty)}</dl>
          {secondaryProperties.length > 0 && <section className="task-details" aria-labelledby="task-details-heading">
            <div className="task-details-heading"><h3 id="task-details-heading">Task details</h3></div>
            <dl className="detail-grid">{secondaryProperties.map(renderProperty)}</dl>
          </section>}
        </aside>
      </div>
    </div>
  </dialog>;
}

// ---- Page (adapted from the plugin's app.tsx; sections, folder settings and quoting are dropped) ----
export function BacklogPage() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [board, setBoard] = useState<BacklogBoard | null>(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [query, setQuery] = useState("");
  const [storage, setStorage] = useState("active");
  const [hideDone, setHideDone] = useState(false);
  const [filters, setFilters] = useState<BoardFilters>(EMPTY_FILTERS);
  const [modal, setModal] = useState<BoardTask | null>(null);
  const [moving, setMoving] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const dragged = useRef<BoardTask | null>(null);
  const serial = useRef(0);
  const load = useCallback(async () => {
    const request = ++serial.current;
    try {
      const { projects: all } = await rpc.call("backlogProjects", null);
      const id = selected && all.some(project => project.id === selected) ? selected : all[0]?.id ?? null;
      const snapshot = id ? await rpc.call("backlogBoard", { projectId: id }) : null;
      if (request !== serial.current) return;
      setProjects(all); setSelected(id); setBoard(snapshot); setError("");
    } catch (cause) { if (request === serial.current) setError(textError(cause)); }
  }, [rpc, selected]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => { serial.current++; clearInterval(timer); };
  }, [load]);
  useEffect(() => { if (connection === "connected") void load(); }, [connection, load]);
  useRealtime("backlog", () => void load());

  const statuses = board?.statuses ?? [];
  const doneStatus = statuses.at(-1);
  const filterOptions = useMemo<FilterOptions>(() => {
    const tasks = board?.tasks ?? [];
    return {
      statuses: [...new Set([...statuses, ...tasks.map(task => task.status)])],
      priorities: [...new Set(tasks.map(task => String(task.fields.priority ?? "")).filter(Boolean))].sort(),
      assignees: [...new Set(tasks.flatMap(assignees))].sort(),
      labels: [...new Set(tasks.flatMap(task => Array.isArray(task.fields.labels) ? task.fields.labels.map(String) : []))].sort(),
    };
  }, [board, statuses]);
  const items = useMemo(() => selectBoardTasks(board?.tasks.filter(task => (storage === "all" || task.storage === storage) && (!hideDone || task.status !== doneStatus) && `${task.id} ${task.title} ${task.body} ${JSON.stringify(task.fields)}`.toLowerCase().includes(query.toLowerCase())) ?? [], filters), [board, storage, hideDone, doneStatus, query, filters]);
  const laneStatuses = [...statuses, ...new Set(items.map(task => task.status).filter(status => !statuses.includes(status)))];

  // A stale revision comes back as {conflict:true}: surface it and reload instead of overwriting.
  const mutation = async (call: () => Promise<{ task: Task | null; conflict: boolean; message: string }>) => {
    const result = await call();
    if (result.conflict) setActionError(result.message);
    await load();
    return result;
  };
  const move = async (task: BoardTask, status: string, beforePath: string | null) => {
    if (!board || moving) return;
    setMoving(true); setActionError("");
    try { await mutation(() => rpc.call("backlogMove", { projectId: board.projectId, path: task.path, revision: task.revision, status, before: beforePath })); }
    catch (cause) { setActionError(textError(cause)); await load(); }
    finally { setMoving(false); }
  };
  const drop = (event: DragEvent, status: string, beforePath: string | null) => {
    event.preventDefault(); event.stopPropagation();
    const task = dragged.current;
    dragged.current = null;
    if (task && task.path !== beforePath) void move(task, status, beforePath);
  };
  const currentTask = modal ? board?.tasks.find(task => task.path === modal.path) ?? modal : null;
  const save = async (edits: Edit[], baseRevision?: string): Promise<SaveResult> => {
    if (!modal || !board) throw new Error("The board is unavailable. Your draft is still here.");
    const result = await mutation(() => rpc.call("backlogSave", { projectId: board.projectId, path: modal.path, revision: baseRevision ?? modal.revision, edits }));
    return { task: result.task ?? currentTask ?? modal, conflict: result.conflict, message: result.message };
  };
  const archive = async () => {
    if (!modal || !board) return;
    const result = await mutation(() => rpc.call("backlogArchive", { projectId: board.projectId, path: modal.path, revision: modal.revision }));
    if (!result.conflict) setModal(null);
  };
  const create = async () => {
    if (!board || !newTitle.trim()) return;
    setActionError("");
    try { await mutation(() => rpc.call("backlogCreate", { projectId: board.projectId, title: newTitle })); setNewTitle(""); }
    catch (cause) { setActionError(textError(cause)); }
  };
  const changeProject = (projectId: string) => { if (modal) return; setSelected(projectId); setBoard(null); setActionError(""); };

  const empty = (title: string, message: string, extra?: string[]) => <div className="empty"><h2>{title}</h2><p>{message}</p>{extra?.map(item => <p key={item}>{item}</p>)}</div>;
  let body: React.ReactNode;
  if (!board) body = <div className="empty">{error ? "" : projects.length || !selected ? "Loading tasks..." : "Select a project to view its tasks."}</div>;
  else if (board.kind === "off") body = empty("Backlog board is off", board.message || "Turn on “Backlog board” in Chief's settings to track todos as Backlog.md tasks.");
  else if (board.kind === "missing") body = empty("No Backlog folder", board.message, board.candidates);
  else if (board.kind === "ambiguous") body = empty("Choose a Backlog folder", board.message, board.candidates);
  else body = <>
    {items.length === 0 && <p className="empty-hint">{board.tasks.length ? "No tasks match these filters." : "No task files yet. Todos added through chief_roster will appear here."}</p>}
    <p id="backlog-keyboard-help" className="visually-hidden">On a focused card, Enter opens the task. Alt plus Left or Right moves between statuses. Alt plus Up or Down reorders the lane.</p>
    <div className="lanes">{laneStatuses.map(status => {
      const lane = items.filter(task => task.status === status);
      return <section className="lane" key={status} aria-label={`${status || "No status"} lane`} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={event => drop(event, status, null)}><header><h2>{status || "No status"}</h2><span>{lane.length}</span></header>{!statuses.includes(status) && <p className="lane-warning">Status is not in configuration. Move cards to a configured lane.</p>}<div className="lane-cards">{lane.map((task, index) => <div className="drop-slot" key={task.path} onDragOver={event => event.preventDefault()} onDrop={event => drop(event, status, task.path)}><TaskCard task={task} subtaskCount={childTasks(task, board.tasks).length} statuses={statuses} open={() => setModal(task)} start={event => { dragged.current = task; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", task.path); }} move={(target, before) => void move(task, target, before)} before={lane[index - 1]?.path ?? null} after={index === lane.length - 1 ? task.path : lane[index + 2]?.path ?? null} /></div>)}<div className="lane-empty">{lane.length ? "Drop to end" : "Drop tasks here"}</div></div></section>;
    })}</div>
  </>;

  const ready = board?.kind === "ready";
  return <div className="backlog-root">
    <header className="app-header">
      <div className="header-project"><strong>Backlog</strong><span aria-hidden="true">/</span><select aria-label="BB project" title={board?.folder ?? undefined} value={selected ?? ""} disabled={Boolean(modal) || !projects.length} onChange={event => changeProject(event.target.value)}>{!projects.length && <option value="">No Chief running</option>}{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
      <div className="header-actions"><span className="connection">{moving ? "Saving move..." : connection === "connected" ? "Live updates" : "Reconnecting"}</span><button onClick={() => void load()}>Refresh</button></div>
    </header>
    <main className="board-area">
      {ready && <div className="controls"><input aria-label="Search tasks" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search tasks" /><select aria-label="Task storage" value={storage} onChange={event => setStorage(event.target.value)}>{Object.entries(STORAGE).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select><label className="completed-toggle"><input type="checkbox" checked={hideDone} onChange={event => setHideDone(event.target.checked)} />Hide {doneStatus || "completed"}</label><form className="new-task" onSubmit={event => { event.preventDefault(); void create(); }}><input aria-label="New task title" placeholder="New task" value={newTitle} onChange={event => setNewTitle(event.target.value)} /><button type="submit" disabled={!newTitle.trim()}>Add</button></form></div>}
      {ready && <BoardControls filters={filters} options={filterOptions} setFilters={setFilters} />}
      {(error || actionError) && <p role="alert" className="notice error">{error || actionError}</p>}
      {board?.warnings.map((warning, index) => <p className="notice" key={index}>{warning}</p>)}
      {body}
    </main>
    {currentTask && <TaskModal key={currentTask.path} task={currentTask} draftStorageKey={`${selected}:${currentTask.path}`} statuses={statuses} relatedTasks={board?.tasks ?? []} onOpenTask={task => setModal(board?.tasks.find(candidate => candidate.path === task.path) ?? null)} fieldChoices={board?.choices} missing={!board?.tasks.some(task => task.path === currentTask.path)} onClose={() => setModal(null)} onSave={save} onArchive={archive} />}
  </div>;
}
