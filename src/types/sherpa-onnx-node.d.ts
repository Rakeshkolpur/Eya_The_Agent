// sherpa-onnx-node ships no TypeScript types. Its actual shape, as used here,
// is described by our own `KeywordSpotterBinding` in
// src/main/wake/keywordSpotter.ts (verified against the real native module);
// this shorthand declaration only lets the `import` resolve.
declare module 'sherpa-onnx-node';
