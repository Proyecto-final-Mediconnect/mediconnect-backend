// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import pluginSecurity from 'eslint-plugin-security';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  // Reglas de seguridad del Sprint 0 §4.8.1 (ENG-166).
  pluginSecurity.configs.recommended,
  {
    rules: {
      // Marca cualquier `obj[clave]` como posible inyección, aun cuando la clave
      // es un tipo cerrado de TypeScript (un `keyof`, una unión de literales).
      // En este código eran 22 falsos positivos y cero casos reales: deja de
      // servir como alarma si siempre suena.
      'security/detect-object-injection': 'off',
    },
  },
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  {
    // En tests, las respuestas de supertest (`res.body`) y los matchers de Jest
    // (`expect.*`) están tipados como `any` por diseño. Relajamos las reglas
    // type-checked `no-unsafe-*` solo en archivos de test para no exigir casts
    // ruidosos en cada aserción. El código de producción sigue estricto.
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', 'test/**/*.ts'],
    rules: {
      // Los tests de integración leen las migraciones SQL con una ruta armada
      // a partir del nombre de la carpeta: no es input de un usuario.
      'security/detect-non-literal-fs-filename': 'off',
      // Los tests arman expresiones con los valores que esperan, no con input.
      'security/detect-non-literal-regexp': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
);
