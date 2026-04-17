let _pipelinePromise;
let _currentModelId;

async function getPipeline(modelMeta) {
  if (_currentModelId !== modelMeta.id) {
    _pipelinePromise = null;
    _currentModelId = modelMeta.id;
  }
  if (!_pipelinePromise) {
    let mod;
    try {
      mod = await import('@xenova/transformers');
    } catch (e) {
      throw new Error(
        'vector mode requires @xenova/transformers: npm install @xenova/transformers',
      );
    }
    _pipelinePromise = mod.pipeline('feature-extraction', modelMeta.id);
  }
  return _pipelinePromise;
}

export async function embedText(modelMeta, text, mode) {
  const pipe = await getPipeline(modelMeta);
  const prefixed = modelMeta.prefix ? `${mode}: ${text}` : text;
  const out = await pipe(prefixed, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

export async function embedBatch(modelMeta, texts, mode) {
  const out = [];
  for (const t of texts) out.push(await embedText(modelMeta, t, mode));
  return out;
}
