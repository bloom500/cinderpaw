/** Bun's file loader: a `.ttf` import is the path of the embedded file. */
declare module "*.ttf" {
  const path: string;
  export default path;
}
