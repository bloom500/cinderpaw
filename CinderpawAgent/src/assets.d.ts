/** Bun's file loader: a `.ttf` import is the path of the embedded file. */
declare module "*.ttf" {
  const path: string;
  export default path;
}

/** Bun's text loader: a `.lock` import is the file's text. */
declare module "*.lock" {
  const text: string;
  export default text;
}
