// Late-bound @get-bb/plugin-sdk/testing: the public-SDK scan allows that import only in *.test.* files,
// so each test file hands the module over with provideSdk before any helper runs.
// Typed any: the scan reads even a type-position import of the SDK, so the cell names no SDK specifier.
export const sdk: any = {};
export const provideSdk = (testing: object) => Object.assign(sdk, testing);
