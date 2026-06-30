// Bun's `import x from './file.c' with { type: 'file' }` yields the bundled
// file's runtime path as a string. Declare the shape so TS accepts it.
declare module '*.c' {
  const path: string;
  export default path;
}
