// Importe, die Vite bündelt (CSS; Testseite: Dateien als Text).
declare module "*.css";
declare module "*?raw" {
  const text: string;
  export default text;
}
