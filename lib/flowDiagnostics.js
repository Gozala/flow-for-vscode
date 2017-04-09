/* @flow */

/*
 Copyright (c) 2015-present, Facebook, Inc.
 All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 the root directory of this source tree.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import {Status} from './flowStatus'
import {Coverage} from './flowCoverage';
import {Uri} from 'vscode';
import type {DiagnosticCollection, ExtensionContext, TextDocument} from 'vscode';

import {flowFindDiagnostics} from './pkg/flow-base/lib/FlowService';
import {isRunOnEditEnabled, hasFlowPragma, getTryPath, toURI} from './utils/util'

let lastDiagnostics: null | DiagnosticCollection = null;
const status = new Status();
const coverage = new Coverage();

export function setupDiagnostics(context:ExtensionContext): void {
	const {subscriptions} = context
	// Do an initial call to get diagnostics from the active editor if any
	if (vscode.window.activeTextEditor) {
		updateDiagnostics(context, vscode.window.activeTextEditor.document);
	}

	// Update diagnostics: when active text editor changes
	subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
		if (editor) {
			updateDiagnostics(context, editor.document);
		}
	}));

	// Update diagnostics when document is edited
	subscriptions.push(vscode.workspace.onDidSaveTextDocument(event => {
		if (vscode.window.activeTextEditor) {
			updateDiagnostics(context, vscode.window.activeTextEditor.document);
		}
	}));

	subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
		const isDocumentActive = vscode.window.activeTextEditor.document === event.document;
		if (isDocumentActive && isRunOnEditEnabled()) {
			updateDiagnostics(context, event.document);
		}
	}));
}

const pendingDiagnostics:Map<string, number> = new Map()

function updateDiagnostics(context:ExtensionContext, document:TextDocument) {
	const {uri, version} = document
	const id = uri.toString()
	const pendingVersion = pendingDiagnostics.get(id)
	if (pendingVersion == null) {
		requestDiagnostics(context, document)
	} else if (pendingVersion !== version) {
		abortDiagnostics(id)
		requestDiagnostics(context, document)
	}
}

function abortDiagnostics(id) {
	if (pendingDiagnostics.has(id)) {
		pendingDiagnostics.delete(id)
	}

	if (pendingDiagnostics.size === 0) {
		status.idle()
	}
}


async function requestDiagnostics(context:ExtensionContext, document:TextDocument) {
	const {uri, version} = document
	const id = uri.toString()
	pendingDiagnostics.set(id, version)
	if (pendingDiagnostics.size > 0) {
		status.busy()
	}
	try {
		let diagnostics = await getDocumentDiagnostics(context, document)
		if (pendingDiagnostics.get(id) === version) {
			applyDiagnostics(diagnostics)
		}
	} catch (error) {
		console.error(error)
	}

  status.idle()
	coverage.update(document.uri);
}

	if (pendingDiagnostics.get(id) === version) {
		pendingDiagnostics.delete(id)
	}

	if (pendingDiagnostics.size === 0) {
		status.idle()
	}
}

async function getDocumentDiagnostics(context:ExtensionContext, document:TextDocument) {
	if (document.isUntitled) {
		return getDraftDocumentDiagnostics(context, document)
	} else if (document.isDirty) {
		return getDirtyDocumentDiagnostics(context, document)
	} else {
		return getSavedDocumentDiagnostics(context, document)
	}
}


const noDiagnostics = Object.create(null);


async function getFileDiagnostics(filePath:string, content:?string, pathToURI=toURI) {
	if (path.extname(filePath) !== '.js' && path.extname(filePath) !== '.jsx') {
		return noDiagnostics; // we only check on JS files
	}

	// flowFindDiagnostics takes the provided filePath and then walks up directories
	// until a .flowconfig is found. The diagnostics are then valid for the entire
	// flow workspace.
	let rawDiag = await flowFindDiagnostics(filePath, content);
	if (rawDiag && rawDiag.messages) {
		const { flowRoot, messages } = rawDiag;
		const diags = Object.create(null);

		messages.forEach((message) => {
			const {level, messageComponents} = message
			if (!messageComponents.length) return

			const
				[baseMessage, ...other] = messageComponents,
				range = baseMessage.range;

			if (range == null) return;

			const file = path.resolve(flowRoot, range.file);
			const uri = pathToURI(file)

			let diag = {
				severity: level,
				startLine: range.start.line,
				startCol: range.start.column,
				endLine: range.end.line,
				endCol: range.end.column,
				msg: ''
			}

			let details = [];
			other.forEach(part => {
				let partMsg = part.descr;
				if (partMsg && partMsg !== 'null' && partMsg !== 'undefined') {
					details.push(partMsg);
				}
			});

			let msg = baseMessage.descr;
			if (details.length) {
				msg = `${msg} (${details.join(' ')})`;
			}

			diag.msg = msg;

			if (!diags[file]) {
				diags[file] = {uri, reports:[]}
			}

			diags[file].reports.push(diag);
		});
		return diags;
	} else {
		return noDiagnostics;
	}
}

const supportedLanguages = new Set(["javascript", "javascriptreact"]);

async function getDraftDocumentDiagnostics(context:ExtensionContext, document:TextDocument) {
	if (supportedLanguages.has(document.languageId)) {
		const content = document.getText();
		if (hasFlowPragma(content)) {
			const tryPath = getTryPath(context)
			const uri = document.uri
			const pathToURI = path =>
				( path == tryPath
				? uri
				: uri
				)

			return getFileDiagnostics(tryPath, content, pathToURI);
		}
	}

	return noDiagnostics;
}

async function getDirtyDocumentDiagnostics(context:ExtensionContext, document:TextDocument) {
	return getFileDiagnostics(document.uri.fsPath, document.getText());
}

async function getSavedDocumentDiagnostics(context:ExtensionContext, document:TextDocument) {
	return getFileDiagnostics(document.uri.fsPath, null);
}

function mapSeverity(sev: string) {
	switch (sev) {
		case "error": return vscode.DiagnosticSeverity.Error;
		case "warning": return vscode.DiagnosticSeverity.Warning;
		default: return vscode.DiagnosticSeverity.Error;
	}
}

function applyDiagnostics(diagnostics) {
	if (lastDiagnostics) {
		lastDiagnostics.dispose(); // clear old collection
	}

	// create new collection
	lastDiagnostics = vscode.languages.createDiagnosticCollection();
	for (let file in diagnostics) {
		const {uri, reports} = diagnostics[file];
		const diags = reports.map(error => {
			// don't allow non-0 lines
			const startLine = Math.max(0, error.startLine - 1)
			const endLine = Math.max(0, error.endLine - 1)
			const range = new vscode.Range(startLine, error.startCol - 1, endLine, error.endCol);
			const location = new vscode.Location(uri, range);

			const diag =  new vscode.Diagnostic(range, error.msg, mapSeverity(error.severity));
			diag.source = 'flow'
			return diag
		})

		lastDiagnostics.set(uri, diags);
	}
}
