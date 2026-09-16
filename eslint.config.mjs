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

    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
        },
        rules: typeAwareRules,
    },
];
