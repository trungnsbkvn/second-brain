import type { Recipe } from '../types.ts';

export const ollama: Recipe = {
  id: 'ollama',
  name: 'Ollama (local)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://localhost:11434/v1',
  auth_env: {
    required: [], // Ollama runs unauthenticated locally; users pass `ollama` as the key.
    optional: ['OLLAMA_BASE_URL', 'OLLAMA_API_KEY'],
    setup_url: 'https://ollama.ai',
  },
  touchpoints: {
    embedding: {
      // Y&P production contract default: bge-m3 @ 1024 (see jus-llm/docs/EMBEDDING_CONTRACT.md
      // and deploy/linux/README.md — won the VN-legal retrieval eval). Other local models
      // remain listed so dim validation + community installs keep working; pick explicitly
      // via --embedding-model ollama:<tag> --embedding-dimensions <native>.
      models: ['bge-m3', 'nomic-embed-text', 'mxbai-embed-large', 'all-minilm'],
      default_dims: 1024, // bge-m3 native
      // Ollama models are not Matryoshka — each emits exactly its native size.
      // all-minilm 384, nomic-embed-text 768, mxbai-embed-large/bge-m3 1024.
      dims_options: [384, 768, 1024],
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-04-20',
      // Ollama's batch capacity depends on the locally loaded model + the
      // OLLAMA_NUM_PARALLEL config; no static cap to declare. v0.32 (#779).
      no_batch_cap: true,
    },
  },
  setup_hint:
    'Install Ollama from https://ollama.ai, then `ollama pull bge-m3` (Y&P default @ 1024d; nomic-embed-text still supported) and `ollama serve`.',
};
