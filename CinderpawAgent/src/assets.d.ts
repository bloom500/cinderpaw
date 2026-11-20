/** Bun's file loader: a `.ttf` import is the path of the embedded file. */
declare module "*.ttf" {
  const path: string;
  export default path;
}

/** The same file loader, for the artifact preview page's fonts and icon. */
declare module "*.woff2" {
  const path: string;
  export default path;
}
declare module "*.png" {
  const path: string;
  export default path;
}

/** Bun's text loader: a `.lock` import is the file's text. */
declare module "*.lock" {
  const text: string;
  export default text;
}
