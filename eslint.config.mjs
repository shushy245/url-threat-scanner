import shalev, { typeAwareRules } from 'eslint-config-shalev';

export default [
    ...shalev,

    { ignores: ['dist/**', 'coverage/**', 'src/db/migrations/**'] },

    {
        settings: {
            'import/resolver': {
                typescript: { alwaysTryTypes: true, project: ['tsconfig.json'] },
                node: true,
            },
        },
    },

    // Boundary: tool configs are loaded BY their tool, which requires a default export. The rule is
    // unsatisfiable here rather than wrong, which is the documented case for a scoped override.
    {
        files: ['vitest.workspace.ts', 'drizzle.config.ts', '*.config.ts', '*.config.mjs'],
        rules: { 'import/no-default-export': 'off' },
    },

    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
        },
        rules: typeAwareRules,
    },
];
