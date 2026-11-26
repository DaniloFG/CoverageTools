import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.vscode-test/**', 'samples/**', 'test/fixtures/**', 'test/ui/fixtures/**'] },
  ...tseslint.configs.recommended,
);
