/* --------------------
* Copyright (C) Matthias Behr, 2020
*/

import * as vscode from 'vscode';
import * as path from 'path';

const smartLogLanguageId: string = "smart-log";

// adapted from https://stackoverflow.com/questions/20070158/string-format-not-work-in-typescript
function stringFormat(str: string, args: RegExpExecArray): string {
	return str.replace(/{(\d+)}/g, function (match, number) {
		return typeof args[number] !== 'undefined'
			? args[number]
			: match
			;
	});
}

interface SelectedTimeData {
	time: Date;
	uri: vscode.Uri;
};

export function activate(context: vscode.ExtensionContext) {
	console.log('mbehr1.smart-log activated.');

	// check whether large file support (mbehr1.vsc-lfs) is available
	// background see: vscode issue #27100, feature request #31078
	const extVscLfs = vscode.extensions.getExtension('mbehr1.vsc-lfs');
	if (!extVscLfs) {
		vscode.window.showInformationMessage(
			'You do not seem to have the "large file" extension installed. So you might not be able to load text files >5MB. Consider installing extension "vsc-lsf".'
		);
	}

	let smartLogs = new SmartLogs();
	context.subscriptions.push(smartLogs);

	let smartLogApi = {
		onDidChangeSelectedTime(listener: any) { return smartLogs.onDidChangeSelectedTime(listener); } // todo looks wrong... any help on proper param types appreciated
	};

	return smartLogApi;
}

// this method is called when your extension is deactivated
export function deactivate() {
	console.log("smart-log deactivated");
}

export interface EventNode {
	label: string;
	uri: vscode.Uri | null; // line provided as fragment #<line>
	parent: EventNode | null;
	children: EventNode[];
};

interface DataPerDocument {
	doc: vscode.TextDocument;
	decorations?: Array<[vscode.TextEditorDecorationType, Array<vscode.DecorationOptions>]>;
	eventTreeNode?: EventNode;
	textEditors?: Array<vscode.TextEditor>;
	identifiedFileConfig?: any
	cachedTimes?: Array<Date>; // per line one date/time
	timeRegex?: RegExp; // from file config or default
	timeAdjustMs?: number; // adjust in ms
};
export default class SmartLogs implements vscode.TreeDataProvider<EventNode>, vscode.Disposable {
	private _subscriptions: Array<vscode.Disposable> = new Array<vscode.Disposable>();
	private _didChangeSelectedTimeSubscriptions: Array<vscode.Disposable> = new Array<vscode.Disposable>();
	private _documents = new Map<string, DataPerDocument>();

	private _smartLogTreeView: vscode.TreeView<EventNode> | undefined = undefined;

	private _rewriteLanguageIds = new Map<string, { firstLineRegEx: RegExp, newLanguageId: string }>(); // e.g. from smart-log to special-log...
	private _supportedLanguageIds = new Array<string>(smartLogLanguageId);

	private _fileConfigs: Array<object> | undefined = vscode.workspace.getConfiguration().get<Array<object>>("smart-log.fileConfigs");
	private _decorationTypes = new Map<string, vscode.TextEditorDecorationType>(); // map with id and settings. init from config in parseDecorations

	private _defaultTimeRegex = new RegExp('^([0-2][0-9]|[0-2][0-9][0-9][0-9])\-([0-1][0-9])\-([0-3][0-9]) ([0-2][0-9])\:([0-5][0-9])\:([0-5][0-9]),([0-9][0-9][0-9])');
	private _timeRegex = vscode.workspace.getConfiguration().get<string>("smart-log.timeRegex") ?
		new RegExp(<string>(vscode.workspace.getConfiguration().get<string>("smart-log.timeRegex"))) : this._defaultTimeRegex;

	private _onDidChangeTreeData: vscode.EventEmitter<EventNode | null> = new vscode.EventEmitter<EventNode | null>();
	readonly onDidChangeTreeData: vscode.Event<EventNode | null> = this._onDidChangeTreeData.event;

	private _onDidChangeSelectedTime: vscode.EventEmitter<SelectedTimeData> = new vscode.EventEmitter<SelectedTimeData>();
	readonly onDidChangeSelectedTime: vscode.Event<SelectedTimeData> = this._onDidChangeSelectedTime.event;

	constructor() {
		console.log(`smart-log() #fileConfigs=${this._fileConfigs?.length}`);

		// register for configuration changes:
		this._subscriptions.push(vscode.workspace.onDidChangeConfiguration((ev) => {
			const affected: boolean = ev.affectsConfiguration("smart-log");
			console.log(`smart-log.onDidChangeConfiguration smart-log affected=${affected}`);
			if (affected) {
				this.parseDecorationsConfig(vscode.workspace.getConfiguration().get<Array<object>>("smart-log.decorations"));
				this._fileConfigs = vscode.workspace.getConfiguration().get<Array<object>>("smart-log.fileConfigs");
				this._timeRegex = vscode.workspace.getConfiguration().get<string>("smart-log.timeRegex") ?
					new RegExp(<string>(vscode.workspace.getConfiguration().get<string>("smart-log.timeRegex"))) : this._defaultTimeRegex;
				console.log(` #fileConfigs=${this._fileConfigs?.length}`);
				this._documents.forEach((data) => {
					data.identifiedFileConfig = undefined; // reset here to let config changes apply
					data.timeRegex = undefined;
					data.cachedTimes = undefined;
					this.updateData(data);
				});
			}
		}));

		this.parseDecorationsConfig(vscode.workspace.getConfiguration().get<Array<object>>("smart-log.decorations"));

		// todo check whether we want to support this. this._subscriptions.push(vscode.languages.registerDocumentHighlightProvider('smart-log', this));

		// register for all documents we do support:
		this._subscriptions.push(vscode.workspace.onDidOpenTextDocument(async (event: vscode.TextDocument) => {
			this.addTextDocument(event);
		}));
		this._subscriptions.push(vscode.workspace.onDidCloseTextDocument((event: vscode.TextDocument) => {
			// console.log(`smart-logs.onDidCloseTextDocument languageId=${event.languageId} uri.scheme=${event.uri.scheme} uri=${event.uri.toString()}`);
			if (this._documents.has(event.uri.toString())) {
				this._documents.delete(event.uri.toString());
			}
			this._onDidChangeTreeData.fire();
			if (this._documents.size === 0) {
				if (this._smartLogTreeView) {
                    /* seems like closing doesn't work. ...so keeping it open
                    this._smartLogTreeView.dispose();
                    this._smartLogTreeView = undefined;
                    console.log(`smartLogTreeView=${this._smartLogTreeView}`); */
				}
			} // note see addTextDocument for the counterpart
		}));

		// initial check for open documents:
		vscode.workspace.textDocuments.forEach(async (value) => {
			console.log(`smart-log: checking already opened textDocument ${value.uri.toString()}`);
			this.addTextDocument(value);
		});

		// on change of active text editor update calculated decorations:
		this._subscriptions.push(vscode.window.onDidChangeActiveTextEditor(async (event: vscode.TextEditor | undefined) => {
			let activeTextEditor = event;
			if (activeTextEditor) {
				console.log(`smart-log.onDidChangeActiveTextEditor ${activeTextEditor.document.uri.toString()} column=${activeTextEditor.viewColumn}`);

				if (this._documents.has(activeTextEditor.document.uri.toString())) {
					const data = this._documents.get(activeTextEditor.document.uri.toString())!;
					// or fire as well if the active one is not supported?
					this._onDidChangeTreeData.fire();
					this.checkActiveTextEditor(data);
					this.updateDecorations(data);
				}
			}
		}));

		this._supportedLanguageIds.forEach((value) => {
			this._subscriptions.push(
				vscode.languages.registerHoverProvider({ language: value }, this));
		});

		// announce time updates on selection of lines:
		this._subscriptions.push(vscode.window.onDidChangeTextEditorSelection(async (ev) => {
			let data = this._documents.get(ev.textEditor.document.uri.toString());
			if (data) {
				// ev.kind: 1: Keyboard, 2: Mouse, 3: Command
				//console.log(`smart-log.onDidChangeTextEditorSelection doc=${data.doc.uri.toString()} ev.kind=${ev.kind} #selections=${ev.selections.length}`);
				// we do only take single selections.
				if (ev.selections.length === 1) {
					const line = ev.selections[0].active.line; // 0-based
					// determine time:
					const time = this.provideTimeByData(data, line);
					// post time update...
					console.log(` smart-log posting time update ${time.toLocaleTimeString()}.${String(time.valueOf() % 1000).padStart(3, "0")}`);
					this._onDidChangeSelectedTime.fire({ time: time, uri: data.doc.uri });
				}
			}
		}));

		// check for changes of the documents
		this._subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
			let data = this._documents.get(event.document.uri.toString());
			if (data) {
				data.cachedTimes = undefined;
				this.updateData(data);
			}
		}));

		// register command for adjustTime
		this._subscriptions.push(vscode.commands.registerTextEditorCommand("smart-log.adjustTime", (textEditor) => {
			console.log(`smart-log.adjustTime for ${textEditor.document.uri.toString()} called...`);
			let data = this._documents.get(textEditor.document.uri.toString());
			if (data) {
				let curAdjustMs: number = data.timeAdjustMs ? data.timeAdjustMs : 0;
				vscode.window.showInputBox({ prompt: `Enter time adjust in secs (cur = ${curAdjustMs / 1000}):`, value: (curAdjustMs / 1000).toString() }).then((value: string | undefined) => {
					if (value) {
						let newAdjustMs: number = (+value) * 1000;
						if (data) {
							data.timeAdjustMs = newAdjustMs;
						}
					}
				});
			}
		}));

		// time-sync feature: check other extensions for api onDidChangeSelectedTime and connect to them.
		// we do have to connect to ourself as well (in case of multiple smart-logs docs)
		this._subscriptions.push(vscode.extensions.onDidChange(() => {
			console.log(`smart-log.extensions.onDidChange #ext=${vscode.extensions.all.length}`);
			this.checkActiveExtensions();
		}));
		setTimeout(() => {
			this.checkActiveExtensions();
		}, 1000);
	}

	dispose() {
		console.log("smart-logs.dispose()");
		this._documents.clear(); // todo have to dispose more? check in detail...
		if (this._smartLogTreeView) {
			this._smartLogTreeView.dispose();
			this._smartLogTreeView = undefined;
		}
		this._didChangeSelectedTimeSubscriptions.forEach((value) => {
			if (value !== undefined) {
				value.dispose();
			}
		});

		this._subscriptions.forEach((value) => {
			if (value !== undefined) {
				value.dispose();
			}
		});
	}

	parseDecorationsConfig(decorationConfigs: Array<object> | undefined): void {
		if (this._decorationTypes.size) {
			// remove current ones from editor:
			this._documents.forEach((value) => {
				value.decorations?.forEach((value) => {
					value[1] = [];
				});
				this.updateDecorations(value);
				value.decorations = undefined;
			});
			this._decorationTypes.clear();
		}
		if (decorationConfigs && decorationConfigs.length) {
			for (let i = 0; i < decorationConfigs.length; ++i) {
				try {
					const conf: any = decorationConfigs[i];
					if (conf.id) {
						console.log(` adding decoration id=${conf.id}`);
						this._decorationTypes.set(conf.id, vscode.window.createTextEditorDecorationType(<vscode.DecorationRenderOptions>conf.renderOptions));
					}
				} catch (error) {
					console.log(`smart-log.parseDecorationsConfig error:${error}`);
				}
			}
		}
		console.log(`smart-log.parseDecorationsConfig got ${this._decorationTypes.size} decorations!`);
	}

	addTextDocument(doc: vscode.TextDocument) {
		console.log(`smart-log.addTextDocument languageId=${doc.languageId} uri.scheme=${doc.uri.scheme} uri=${doc.uri.toString()}`);
		if (this._documents.has(doc.uri.toString())) {
			console.log("smart-log.addTextDocument we do have this doc already. Ignoring!");
		} else {

			// shall we change the languageId? (todo document feature and add config settings)
			if (this._rewriteLanguageIds.has(doc.languageId)) {
				// we can check e.g. for certain regex in first line here and then call
				const firstLine = doc.lineAt(0);
				const langSet = this._rewriteLanguageIds.get(doc.languageId);
				if (langSet?.firstLineRegEx.exec(firstLine.text)) {
					console.log(`smart-log.addTextDocument changing languageId from ${doc.languageId} to ${langSet.newLanguageId} due to first line match of ${langSet.firstLineRegEx}`);
					vscode.languages.setTextDocumentLanguage(doc, langSet.newLanguageId);
					return; // a close doc, open doc will follow
				}
			}

			// do we support this document?
			if (this._supportedLanguageIds.includes(doc.languageId)) {
				console.log(`smart-log.addTextDocument adding ${doc.uri.toString()}`);
				let data: DataPerDocument = { doc: doc };
				this._documents.set(doc.uri.toString(), data);
				setTimeout(() => {
					this.updateData(data);
				}, 1000);
			}

			if (this._documents.size > 0) {
				if (!this._smartLogTreeView) {
					// treeView support for log files
					this._smartLogTreeView = vscode.window.createTreeView('smartLogEventsExplorer', {
						treeDataProvider: this
					});
					this._subscriptions.push(this._smartLogTreeView.onDidChangeSelection(event => {
						console.log(`smartLogTreeView.onDidChangeSelection(${event.selection.length} ${event.selection[0].uri})`);
						if (event.selection.length && event.selection[0].uri) {
							// find the editor for this uri in active docs:
							let uriWoFrag = event.selection[0].uri.with({ fragment: "" }).toString();
							const activeTextEditors = vscode.window.visibleTextEditors;
							// console.log(`smartLogTreeView.onDidChangeSelection. finding editor for ${uriWoFrag}, activeTextEditors=${activeTextEditors.length}`);
							for (let ind = 0; ind < activeTextEditors.length; ++ind) {
								const editor = activeTextEditors[ind];
								const editorUri = editor.document.uri.toString();
								// console.log(` comparing with ${editorUri}`);
								if (editor && uriWoFrag === editorUri) {
									console.log(`  revealing ${event.selection[0].uri} line ${+(event.selection[0].uri.fragment)}`);
									editor.revealRange(new vscode.Range(+(event.selection[0].uri.fragment), 0, +(event.selection[0].uri.fragment) + 1, 0), vscode.TextEditorRevealType.AtTop);
								}
							}

						}
					}));
					this._smartLogTreeView.reveal({ label: "", uri: null, parent: null, children: [] });
				}
			}
		}
	}

	public provideHover(doc: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
		const posTime = this.provideTime(doc, position);
		//const timePos = this.providePositionCloseTo(doc, posTime);
		return new vscode.Hover({ language: "smart-log", value: `calculated time: ${posTime.toLocaleTimeString()}.${posTime.valueOf() % 1000} line#=${position.line}` }); // posCloseTo=${timePos?.line}` });
	}

	public provideDocumentHighlights(doc: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.DocumentHighlight[]> {
		console.log(`smart-log.provideDocumentHighlights(doc=${doc.uri.toString()}pos=${position.line}:${position.character}`);
		let data = this._documents.get(doc.uri.toString());
		if (data) {
			// todo
		} else {
			console.log(" called for an unknown/unhandled document!");
		}
		return null;
	}

	provideTime(doc: vscode.TextDocument, pos: vscode.Position): Date {
		// console.log(`smart-log.provideTime(doc=${doc.uri.toString()}, pos.line=${pos.line}})`);
		let data = this._documents.get(doc.uri.toString());
		if (data) {
			return this.provideTimeByData(data, pos.line);
		} else {
			console.log("smart-log.provideTime called for an unknown/unhandled document!");
		}
		return new Date(0);
	}

	provideTimeByData(data: DataPerDocument, line: number): Date {
		if (data.cachedTimes && line < data.cachedTimes.length) {
			const toRet = data.cachedTimes[line];
			if (data.timeAdjustMs) {
				return new Date(toRet.valueOf() + data.timeAdjustMs);
			} else {
				return toRet;
			}
		} else {
			if (!data.timeRegex) {
				console.log("smart-log.provideTimeByData has no timeRegex!");
				return new Date(0);
			}
			// we reset the times here in any case:
			data.cachedTimes = new Array<Date>();

			// calc times for full document here (we could calc only for 0-pos.line...)
			//  for each line provide time from current or lines above that have a time.
			for (let i = 0; i < data.doc.lineCount; ++i) {
				let curLine = data.doc.lineAt(i).text;
				let regRes = curLine.match(data.timeRegex);
				if (regRes) {
					if (regRes.length >= 7) {
						let year = +regRes[1];
						if (year < 100) { year += 2000; }
						const ms: number = regRes[7] ? +regRes[7] : 0;
						let date = new Date(year, +regRes[2] - 1, +regRes[3], +regRes[4], +regRes[5], +regRes[6], ms);
						data.cachedTimes.push(date);
					} else if (regRes.length === 2) {
						let date = new Date(regRes[1]);
						data.cachedTimes.push(date);
					}
				} else {
					// use the one from prev. line
					if (i > 0) {
						data.cachedTimes.push(data.cachedTimes[i - 1]);
					} else {
						data.cachedTimes.push(new Date(0));
					}
				}
			}
			console.log(`smart-log.provideTime calculated all times. (lines=${data.cachedTimes.length})`);
			const toRet = data.cachedTimes[line];
			if (data.timeAdjustMs) {
				return new Date(toRet.valueOf() + data.timeAdjustMs);
			} else {
				return toRet;
			}
		}
	}

	public providePositionCloseTo(doc: vscode.TextDocument, date: Date): vscode.Position | undefined {
		console.log(`smart-log.providePositionCloseTo(doc=${doc.uri.toString()}) :`, date);
		let data = this._documents.get(doc.uri.toString());
		if (data) {
			// todo do binary search (difficulty === doesnt work >= and prev line <)
			for (let i = 0; i < data.doc.lineCount; ++i) {
				const lineTime = this.provideTime(data.doc, new vscode.Position(i, 0));
				if (lineTime.valueOf() >= date.valueOf()) {
					if (lineTime.valueOf() === date.valueOf()) {
						return new vscode.Position(i, 0);
					}
					// if > return the prev. line.
					if (i > 0) {
						return new vscode.Position(i - 1, 0);
					} else {
						return undefined;
					}
				}
			}
			return undefined;
		} else {
			console.log(" called for an unknown/unhandled document!");
		}
		return undefined;
	}

    /*
     * decorations support
     */
	updateData(data: DataPerDocument): void {
		console.log(`smart-log.updateData(document.uri=${data.doc.uri.toString()})...`);
		const doc = data.doc;
		const text = doc.getText();
		let match;

		// identify file config. The first matching one will be used:
		// we could cache the one here! (todo and then reset cached one on config update)
		let identifiedFileConfig: any | undefined = data.identifiedFileConfig;
		if (!identifiedFileConfig) {
			if (this._fileConfigs) {
				for (let i = 0; i < this._fileConfigs.length; ++i) {
					const fileConfig: any = this._fileConfigs[i];
					try {
						const name: string = fileConfig.name;
						const identifyRegexStr: string = fileConfig.identifyRegex;
						console.log(` checking fileConfig ${name} with identifyRegex ${identifyRegexStr}`);
						if (name && identifyRegexStr) {
							const identifyRegex: RegExp = new RegExp(identifyRegexStr);
							if (identifyRegex.exec(doc.getText())) {
								console.log(` fileConfig ${name} matches!`);
								identifiedFileConfig = fileConfig;
								break;
							}
						}
					} catch (error) {
						console.log(`  error:${error}`);
					}
				}
			}
		}

		if (identifiedFileConfig) {

			if (identifiedFileConfig.timeRegex) {
				data.timeRegex = new RegExp(<string>identifiedFileConfig.timeRegex);
			} else {
				console.log(" using default timeRegex");
				data.timeRegex = this._timeRegex;
			}

			const events: any | undefined = identifiedFileConfig.events;
			// create the RegExps here to have them compiled and not created line by line
			let rEvents = new Array<{ regex: RegExp, label: string, level: number, decorationId?: string }>();
			if (events) {
				for (let i = 0; i < events.length; ++i) {
					const event: any | undefined = events[i];
					if (event.regex) { // level, label and decorationId are optional
						rEvents.push({ regex: new RegExp(event.regex), label: event.label, level: event.level ? event.level : 0, decorationId: event.decorationId });
					}
				}
			}

			console.log(` identifiedFileConfig ${identifiedFileConfig.name} matches with ${rEvents.length}!`);

			let eventRoot: EventNode = { label: identifiedFileConfig.name, uri: doc.uri, parent: null, children: [] };
			let decorations = new Map<vscode.TextEditorDecorationType, vscode.DecorationOptions[]>();

			function getParent(level: number): EventNode {
				if (level === 1) {
					return eventRoot;
				} else {
					const parent = getParent(level - 1);
					if (parent.children.length === 0) {
						// create a dummy and return that one:
						parent.children.push({ label: `(no parent level ${level - 1} event)`, uri: doc.uri, parent: parent, children: [] }); // todo add line number?
					}
					return parent.children[parent.children.length - 1];
				}
			}

			try {
				if (rEvents.length) {
					for (let i = 0; i < doc.lineCount; ++i) {
						const line = doc.lineAt(i);

						// scan for event matches: (in sequence due to level, so sadly not in parallel...)
						for (let j = 0; j < rEvents.length; ++j) {
							const ev = rEvents[j];
							if (match = ev.regex.exec(line.text)) {
								let label: string = ev.label ? stringFormat(ev.label, match) : `${match[0]}`;
								if (ev.level > 0) {
									const parentNode = getParent(ev.level);
									parentNode.children.push({ label: label, uri: doc.uri.with({ fragment: `${line.lineNumber}` }), parent: parentNode, children: [] });
								}
								if (ev.decorationId) {
									if (this._decorationTypes.has(ev.decorationId)) {
										const decoration = this._decorationTypes.get(ev.decorationId);
										if (decoration) {
											if (!decorations.has(decoration)) {
												decorations.set(decoration, []);
											}
											decorations.get(decoration)?.push({ range: line.range, hoverMessage: `${label}` });
										}
									}
								}
							}
						}
					}
				}
			} catch (error) {
				console.log(`error: ${error} occurred!`);
			}
			data.eventTreeNode = eventRoot;

			data.decorations = new Array<[vscode.TextEditorDecorationType, Array<vscode.DecorationOptions>]>();
			decorations.forEach((value, key) => { // todo if a prev. DecorationType is missing it's not set!
				data.decorations?.push([key, value]);
			});

		} else {
			console.log(`smart-log.updateData(document.uri=${data.doc.uri.toString()}) has no data!`);
			// no config
			data.eventTreeNode = undefined;
			data.decorations = undefined; // this won't delete the old ones! todo
		}

		this.checkActiveTextEditor(data);
		this.updateDecorations(data);
		// we fire here the event as well to update the tree:
		this._onDidChangeTreeData.fire();
	}

	checkActiveTextEditor(data: DataPerDocument) {
		if (vscode.window.activeTextEditor) {
			if (vscode.window.activeTextEditor.document.uri.toString() === data.doc.uri.toString()) {
				if (!data.textEditors) {
					data.textEditors = new Array<vscode.TextEditor>();
				}
				if (!data.textEditors.includes(vscode.window.activeTextEditor)) {
					data.textEditors.push(vscode.window.activeTextEditor);
				}
			}
		}
	}

	updateDecorations(data: DataPerDocument) {
		// update decorations:
		if (data.textEditors) {
			data.textEditors.forEach((editor) => {
				if (data.decorations) {
					data.decorations.forEach((value) => {
						editor.setDecorations(value[0], value[1]);
					});
				}
			});
		}
	}

    /*
     * treeview support
     */

	// lifecycle tree view support:
	public getTreeItem(element: EventNode): vscode.TreeItem {
		// console.log(`smart-log.getTreeItem(${element.label}, ${element.uri?.toString()}) called.`);
		return {
			label: element.label.length ? element.label : "<no events>",
			collapsibleState: element.children.length ? vscode.TreeItemCollapsibleState.Collapsed : void 0,
			iconPath: /* (element.children.length === 0 && element.label.startsWith("xy")) ? path.join(__filename, '..', '..', 'media', 'root-folder.svg') : */ undefined // todo!
		};
	}

	public getChildren(element?: EventNode): EventNode[] | Thenable<EventNode[]> {
		// console.log(`smart-log.getChildren(${element?.label}, ${element?.uri?.toString()}) this=${this} called.`);
		if (!element) { // if no element we have to return the root element.
			// check whether we have a EventNode for the current document:
			const doc = vscode.window.activeTextEditor?.document;
			if (doc && this) {
				const node = this._documents.get(doc.uri.toString())?.eventTreeNode;
				if (node) {
					// console.log(` eventTreeNode for doc ${doc.uri.toString()} found`);
					return [node];
				}
				console.log(` no eventTreeNode for doc ${doc.uri.toString()} available`);
			}
			return [{ label: "", uri: null, parent: null, children: [] }];
		} else {
			return element.children;
		}
	}

	public getParent(element: EventNode): vscode.ProviderResult<EventNode> {
		// console.log(`smart-log.getParent(${element.label}, ${element.uri?.toString()}) called.`);
		return element.parent;
	}

	handleDidChangeSelectedTime(ev: SelectedTimeData) {
		console.log(`smart-log.handleDidChangeSelectedTime got ev from uri=${ev.uri.toString()}`);
		this._documents.forEach((value) => {
			if (value.doc.uri.toString() !== ev.uri.toString()) {
				console.log(` trying to reveal ${ev.time.toLocaleTimeString()} at doc ${value.doc.uri.toString()}`);
				let position = this.providePositionCloseTo(value.doc, ev.time);
				if (position && value.textEditors) {
					const posRange = new vscode.Range(position, position);
					value.textEditors.forEach((value) => {
						value.revealRange(posRange, vscode.TextEditorRevealType.AtTop);
						// todo add/update decoration as well
					});
				}
			}
		});
	}

	checkActiveExtensions() {
		this._didChangeSelectedTimeSubscriptions.forEach((value) => {
			if (value !== undefined) {
				value.dispose();
			}
		});
		this._didChangeSelectedTimeSubscriptions = new Array<vscode.Disposable>();

		vscode.extensions.all.forEach((value) => {
			if (value.isActive) {
				// console.log(`smart-log:found active extension: id=${value.id}`);// with #exports=${value.exports.length}`);
				try {
					let importedApi = value.exports;
					if (importedApi !== undefined) {
						let subscr = importedApi.onDidChangeSelectedTime(async (ev: SelectedTimeData) => {
							this.handleDidChangeSelectedTime(ev);
						});
						if (subscr !== undefined) {
							console.log(` got onDidChangeSelectedTime api from ${value.id}`);
							this._didChangeSelectedTimeSubscriptions.push(subscr);
						}
					}
				} catch (error) {
					console.log(`smart-log:extension ${value.id} throws: ${error}`);
				}
			}
		});
		console.log(`smart-log.checkActiveExtensions: got ${this._didChangeSelectedTimeSubscriptions.length} subscriptions.`);
	}

}