// Wrangler's `Data` rule (wrangler.jsonc, scripts/setup.mjs) gives an imported binary its bytes as an ArrayBuffer.
declare module "*.jpg" {
  const data: ArrayBuffer;
  export default data;
}
