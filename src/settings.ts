/** Effective settings of one workspace folder. */
export interface Settings {
  watchEnabled: boolean;
  watchGlobs: string[];
  exclude: string[];
  nestedProjects: 'inner' | 'outer';
  dotnetCollector: string;
  dotnetExtraArgs: string[];
  nodeExtraArgs: string[];
  pythonInterpreter: string;
  pythonExtraArgs: string[];
  commands: Record<string, string>;
}

export const DEFAULT_SETTINGS: Settings = {
  watchEnabled: true,
  watchGlobs: [
    '**/TestResults/**/*.cobertura.xml',
    '**/coverage/coverage-final.json',
    '**/coverage/lcov.info',
    '**/coverage/cobertura-coverage.xml',
    '**/coverage.xml',
    '**/coverage.lcov',
    '**/.coverage',
  ],
  exclude: ['**/node_modules/**', '**/bin/**', '**/obj/**', '**/.venv/**', '**/venv/**', '**/__pycache__/**'],
  nestedProjects: 'inner',
  dotnetCollector: '',
  dotnetExtraArgs: [],
  nodeExtraArgs: [],
  pythonInterpreter: '',
  pythonExtraArgs: [],
  commands: {},
};
