# Pipeline de IA

Lo que corre en GitHub Actions y no en el backend de Render (ADR-020, opción A,
decidida el 22/11/2026): con el modelo de reconocimiento de entidades, el backend
llegaría a ~480 MB de los 512 MB de Render free.

Es un proyecto aparte, con su `package.json` (npm) y su `tsconfig.json`: sus
dependencias pesan ~1,4 GB y no se instalan con el backend. Importa el núcleo de
`../src/ai/`, que no tiene dependencias.

Hoy tiene la capa 3 de la seudonimización (ENG-215). El pipeline completo
(transcribir, seudonimizar, resumir y reidentificar) llega con ENG-214.

```bash
cd ai-pipeline
npm ci
npm run typecheck
npm run eval:pseudonymization   # SHOW_TEXT=1 para ver el texto seudonimizado
```

`overrides` fuerza `sharp` 0.35.5: lo trae `@huggingface/transformers` para
procesar imágenes (acá no se usa) y la versión que pide tiene vulnerabilidades
altas. El workflow corre `npm audit` y falla si aparece otra.

La primera corrida baja el modelo de Hugging Face (~130 MB). `HF_CACHE_DIR` dice
dónde guardarlo; el workflow lo cachea entre corridas.

Ver `src/ai/pseudonymization/README.md` para qué se tapa, cómo se mide y sus
límites.
