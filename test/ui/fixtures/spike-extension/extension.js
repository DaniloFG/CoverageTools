// Probe extension for the UI spike: publishes a coverage-only test run with no test items.
const vscode = require('vscode');

function activate(context) {
  const controller = vscode.tests.createTestController('spike', 'Spike');
  context.subscriptions.push(controller);

  const profile = controller.createRunProfile('Spike Coverage', vscode.TestRunProfileKind.Coverage, () => {}, false);
  profile.loadDetailedCoverage = async () => [
    new vscode.StatementCoverage(1, new vscode.Position(0, 0)),
    new vscode.StatementCoverage(0, new vscode.Position(1, 0)),
  ];

  context.subscriptions.push(
    vscode.commands.registerCommand('spike.publish', () => {
      const folder = vscode.workspace.workspaceFolders[0].uri;
      const run = controller.createTestRun(new vscode.TestRunRequest(undefined, undefined, profile), 'Spike', false);
      run.addCoverage(new vscode.FileCoverage(vscode.Uri.joinPath(folder, 'a.txt'), new vscode.TestCoverageCount(1, 2)));
      run.end();
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
