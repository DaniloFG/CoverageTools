import * as vscode from 'vscode';
import { pythonExtensionSelection } from './pythonApi';

/**
 * The interpreter selected in the Microsoft Python extension for `uri`, when that extension is
 * installed and already active (it is never activated from here); otherwise undefined.
 */
export function selectedPythonInterpreter(uri: vscode.Uri): string | undefined {
  return pythonExtensionSelection(vscode.extensions, uri);
}
