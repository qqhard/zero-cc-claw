export const MODELS = {
  'multilingual-e5-small': {
    id: 'Xenova/multilingual-e5-small',
    dim: 384,
    prefix: true,
    size: '~120MB',
    lang: 'mixed',
  },
  'bge-small-zh-v1.5': {
    id: 'Xenova/bge-small-zh-v1.5',
    dim: 384,
    prefix: false,
    size: '~95MB',
    lang: 'zh',
  },
  'bge-small-en-v1.5': {
    id: 'Xenova/bge-small-en-v1.5',
    dim: 384,
    prefix: false,
    size: '~130MB',
    lang: 'en',
  },
};

export const DEFAULT_MODEL = 'multilingual-e5-small';

export function resolveModel(name) {
  const m = MODELS[name];
  if (!m) {
    throw new Error(
      `unknown model: ${name}. known: ${Object.keys(MODELS).join(', ')}`,
    );
  }
  return { ...m, name };
}
