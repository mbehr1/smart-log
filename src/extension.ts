/* --------------------
* Copyright (C) Matthias Behr, 2020
*/

import * as vscode from 'vscode';
import * as util from './util';
import * as path from 'path';
import TelemetryReporter from 'vscode-extension-telemetry';
import * as d3 from 'd3-time-format';

const textScheme: string = 'smart-log';

let reporter: TelemetryReporter;

const smartLogLanguageId: string = "smart-log";

interface TimeSyncData {
	time: Date,
	id: string,
	value: string,
	prio: number
};

interface SelectedTimeData {
	time: Date;
	uri: vscode.Uri;
	timeSyncs?: Array<TimeSyncData>; // these are not specific to a selected line. Time will be 0 then.
};

export function activate(context: vscode.ExtensionContext) {
	console.log('mbehr1.smart-log activated.');
	const extensionId = 'mbehr1.smart-log';
	const extension = vscode.extensions.getExtension(extensionId);

	if (extension) {
		const extensionVersion = extension.packageJSON.version;
		// the aik is not really sec_ret. but lets avoid bo_ts finding it too easy:
		const strKE = 'ZjJlMDA4NTQtNmU5NC00ZDVlLTkxNDAtOGFiNmIzNTllODBi';
		const strK = Buffer.from(strKE, "base64").toString();
		reporter = new TelemetryReporter(extensionId, extensionVersion, strK);
		context.subscriptions.push(reporter);
		reporter?.sendTelemetryEvent('activate');
	} else {
		console.log(`${extensionId}: not found as extension!`);
	}
	// check whether large file support (mbehr1.vsc-lfs) is available
	// background see: vscode issue #27100, feature request #31078
	const extVscLfs = vscode.extensions.getExtension('mbehr1.vsc-lfs');
	if (!extVscLfs) {
		vscode.window.showInformationMessage(
			'You do not seem to have the "large file" extension installed. So you might not be able to load text files >50MB. Consider installing extension "vsc-lsf".'
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
	id: string;
	label: string;
	uri: vscode.Uri | null; // line provided as fragment #<line>
	parent: EventNode | null;
	children: EventNode[];
	contextValue?: string;
	icon?: vscode.ThemeIcon;
};

interface DataPerDocument {
	doc: vscode.TextDocument;
	decorations?: Array<[vscode.TextEditorDecorationType, Array<vscode.DecorationOptions>]>;
	eventTreeNode?: EventNode;
	textEditors?: Array<vscode.TextEditor>;
	identifiedFileConfig?: any
	cachedTimes?: Array<Date>; // per line one date/time
	timeRegex?: RegExp; // from file config or default
	timeFormat?: string;
	d3TimeParser?: any;
	timeAdjustMs?: number; // adjust in ms
	lastSelectedTimeEv: Date | undefined; // the last received time event that might have been used to reveal our line. used for adjustTime on last event feature.
	gotTimeSyncEvents: boolean; // we've synced at least once to our time based on timeSync events
	timeSyncs: Array<[number, TimeSyncData]>; // line, TimeSyncData here without time but line number
};
export default class SmartLogs implements vscode.TreeDataProvider<EventNode>, vscode.TextDocumentContentProvider, vscode.Disposable {
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
	private _timeFormat = vscode.workspace.getConfiguration().get<string>("smart-log.timeFormat");

	private _autoTimeSync = false; // todo config

	private _onDidChangeTreeData: vscode.EventEmitter<EventNode | null> = new vscode.EventEmitter<EventNode | null>();
	readonly onDidChangeTreeData: vscode.Event<EventNode | null> = this._onDidChangeTreeData.event;
	private lastSelectedNode: EventNode | null = null;

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
				this._timeFormat = vscode.workspace.getConfiguration().get<string>("smart-log.timeFormat");
				console.log(` #fileConfigs=${this._fileConfigs?.length}`);
				this._documents.forEach((data) => {
					data.identifiedFileConfig = undefined; // reset here to let config changes apply
					data.timeRegex = undefined;
					data.timeFormat = undefined;
					data.d3TimeParser = undefined;
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
		this._subscriptions.push(vscode.window.onDidChangeTextEditorSelection(util.throttle(async (ev) => {
			if (this._autoTimeSync) {
				let data = this._documents.get(ev.textEditor.document.uri.toString());
				if (data) {
					// ev.kind: 1: Keyboard, 2: Mouse, 3: Command
					//console.log(`smart-log.onDidChangeTextEditorSelection doc=${data.doc.uri.toString()} ev.kind=${ev.kind} #selections=${ev.selections.length}`);
					// we do only take single selections.
					if (ev.selections.length === 1) {
						const line = ev.selections[0].active.line; // 0-based
						const time: Date = await this.provideTimeByData(data, line);
						// post time update...
						if (time.valueOf() > 0) {
							console.log(` smart-log posting time update ${time.toLocaleTimeString()}.${String(time.valueOf() % 1000).padStart(3, "0")}`);
							this._onDidChangeSelectedTime.fire({ time: time, uri: data.doc.uri });
						}
					}
				}
			}
		}, 500)));

		// check for changes of the documents
		this._subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
			let data = this._documents.get(event.document.uri.toString());
			if (data) {
				console.log(`onDidChangeTextDocument data.doc.lineCount=${data.doc.lineCount}`);
				data.cachedTimes = undefined;
				this.updateData(data);
			}
		}));

		// provide text docs from e.g. events:
		this._subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(textScheme, this));
		this._subscriptions.push(vscode.commands.registerCommand("smart-log.openAsTextDoc", (...args) => {
			const node = <EventNode>args[0];
			if (node) {
				console.log(`smart-log.openAsTextDoc called with node='${node.label}' and uri='${node.uri?.toString()}'`);
				if (node.uri) {
					const uri = util.createUri(textScheme, `events ${node.label}`, { uri: node.uri, nodeId: node.id });
					console.log(`smart-log.openAsTextDoc  calling uri='${uri.toString()}'`);
					vscode.commands.executeCommand('vscode.open', uri, { preview: false });
				}
			}
		}));
		this._subscriptions.push(vscode.commands.registerCommand("smart-log.openAsTextDiff", (...args) => {
			const node = <EventNode>args[0];
			if (node) {
				console.log(`smart-log.openAsTextDoc called with node='${node.label}' and uri='${node.uri?.toString()}'`);
				// check whether that node is the active selection as well. if not we do diff:
				if (this._smartLogTreeView && this._smartLogTreeView.selection.length > 0) {
					const selectedNode = this._smartLogTreeView?.selection[0]; // could use lastSelectedNode
					if (selectedNode !== node) {
						// let's diff
						console.log(`smart-log.openAsTextDiff doing a diff from selected node='${selectedNode?.label}' to node '${node.label}'`);
						const uri1 = util.createUri(textScheme, `events ${selectedNode.label}`, { uri: selectedNode.uri, nodeId: selectedNode.id });
						const uri2 = util.createUri(textScheme, `events ${node.label}`, { uri: node.uri, nodeId: node.id });
						vscode.commands.executeCommand('vscode.diff', uri1, uri2, `events '${selectedNode.label}'<->'${node.label}'`, { preview: false });
						return;
					}
				}
			}
		}));

		// register command for adjustTime
		this._subscriptions.push(vscode.commands.registerTextEditorCommand("smart-log.adjustTime", async (textEditor) => {
			console.log(`smart-log.adjustTime for ${textEditor.document.uri.toString()} called...`);
			let data = this._documents.get(textEditor.document.uri.toString());
			if (data) {
				let curAdjustMs: number = data.timeAdjustMs ? data.timeAdjustMs : 0;
				// check first whether we shall use the last received time event?
				// we do this only if we didn't receive any timeSyncs (assuming that the next one will auto update anyhow so it makes no sense to change man.)
				let doManualPrompt = true;
				if (!data.gotTimeSyncEvents && data.lastSelectedTimeEv) {
					// determine current selected time:
					if (textEditor.selections.length === 1) {
						const line = textEditor.selections[0].active.line; // 0-based
						const time: Date | undefined = this.provideTimeByDataSync(data, line);
						if (time && time.valueOf() > 0) {
							// calc adjust value:
							let selTimeAdjustValue = data.lastSelectedTimeEv.valueOf() - time.valueOf();
							let response: string | undefined =
								await vscode.window.showInformationMessage(`Adjust based on last received time event (adjust by ${selTimeAdjustValue / 1000} secs)?`,
									{ modal: true }, "yes", "no");
							if (response === "yes") {
								doManualPrompt = false;
								this.adjustTime(data, selTimeAdjustValue);
							} else if (!response) {
								doManualPrompt = false;
							}
						}
					}
				}
				if (doManualPrompt) {
					vscode.window.showInputBox({ prompt: `Enter new time adjust in secs (cur = ${curAdjustMs / 1000}):`, value: (curAdjustMs / 1000).toString() }).then(async (value: string | undefined) => {
						if (value) {
							let newAdjustMs: number = (+value) * 1000;
							if (data) {
								this.adjustTime(data, newAdjustMs - curAdjustMs);
							}
						}
					});
				}
			}
		}));

		this._subscriptions.push(vscode.commands.registerCommand("smart-log.toggleTimeSync", () => {
			console.log(`smart-log.toggleTimeSync called...`);
			this._autoTimeSync = !this._autoTimeSync;
			vscode.window.showInformationMessage(`Auto time-sync turned ${this._autoTimeSync ? "on. Selecting a line will send the corresponding time." : "off. To send the time use the context menu 'send selected time' command."}`);
		}));

		this._subscriptions.push(vscode.commands.registerTextEditorCommand("smart-log.sendTimeSyncEvents", async (textEditor) => {
			console.log(`smart-log.sendTimeSyncEvents for ${textEditor.document.uri.toString()} called...`);
			let data = this._documents.get(textEditor.document.uri.toString());
			if (data) {
				this.broadcastTimeSyncs(data);
			}
		}));

		this._subscriptions.push(vscode.commands.registerTextEditorCommand("smart-log.sendTime", async (textEditor) => {
			console.log(`smart-log.sendTime for ${textEditor.document.uri.toString()} called...`);
			let data = this._documents.get(textEditor.document.uri.toString());
			if (data) {
				// ev.kind: 1: Keyboard, 2: Mouse, 3: Command
				//console.log(`smart-log.onDidChangeTextEditorSelection doc=${data.doc.uri.toString()} ev.kind=${ev.kind} #selections=${ev.selections.length}`);
				// we do only take single selections.
				if (textEditor.selections.length === 1) {
					const line = textEditor.selections[0].active.line; // 0-based
					const time: Date = await this.provideTimeByData(data, line);
					// post time update...
					if (time.valueOf() > 0) {
						console.log(` smart-log posting time update ${time.toLocaleTimeString()}.${String(time.valueOf() % 1000).padStart(3, "0")}`);
						this._onDidChangeSelectedTime.fire({ time: time, uri: data.doc.uri });
					}
				}
			}
		}));

		// time-sync feature: check other extensions for api onDidChangeSelectedTime and connect to them.
		// we do have to connect to ourself as well (in case of multiple smart-logs docs)
		this._subscriptions.push(vscode.extensions.onDidChange(() => {
			console.log(`smart-log.extensions.onDidChange #ext=${vscode.extensions.all.length}`);
			setTimeout(() => {
				this.checkActiveExtensions();
			}, 1500); // let the new ext. start first. This introduces a race for auto-time-sync events.todo
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

	async adjustTime(data: DataPerDocument, relOffset: number) {
		if (!data.timeAdjustMs) { data.timeAdjustMs = 0; }
		data.timeAdjustMs += relOffset;
		console.log(`dlt-logs.adjustTime(${relOffset}) to new offset: ${data.timeAdjustMs}`);

		// update times for timesyncs:
		if (data.timeSyncs) {
			for (let i = 0; i < data.timeSyncs.length; ++i) {
				const timeSyncEvent = data.timeSyncs[i];
				timeSyncEvent[1].time = await this.provideTimeByData(data, timeSyncEvent[0]);
			}
			this.broadcastTimeSyncs(data);
		}
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
		if (doc.uri.scheme === textScheme) { return; } // we ignore our internal scheme
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
				let data: DataPerDocument = { doc: doc, timeSyncs: [], lastSelectedTimeEv: undefined, gotTimeSyncEvents: false };
				this._documents.set(doc.uri.toString(), data);
				setTimeout(() => {
					this.updateData(data);
				}, 1000);
				reporter?.sendTelemetryEvent("open file", undefined, { 'nrFileConfigs': this._fileConfigs ? this._fileConfigs.length : 0 });
			}

			if (this._documents.size > 0) {
				if (!this._smartLogTreeView) {
					// treeView support for log files
					this._smartLogTreeView = vscode.window.createTreeView('smartLogEventsExplorer', {
						treeDataProvider: this
					});
					this._subscriptions.push(this._smartLogTreeView.onDidChangeSelection(event => {
						console.log(`smartLogTreeView.onDidChangeSelection(${event.selection.length} ${event.selection[0].uri}) ${event.selection[0].id}`);
						if (event.selection.length && event.selection[0].uri) {
							// we mark the last selected one. its a bit sad but I didn't found a when clause for it.
							if (this.lastSelectedNode !== null) {
								this.lastSelectedNode.contextValue = undefined;
								const toUnselect = this.lastSelectedNode;
								console.log(`smartLogTreeView.onDidChangeSelection unselecting ${this.lastSelectedNode.id} ${this.lastSelectedNode.contextValue}`);
								// strangely this must be sent async otherwise duplicated ids get reported??? (weird vscode behaviour)
								setTimeout(() => {
									//console.log(`smartLogTreeView.onDidChangeSelection unselecting ${toUnselect.id} ${toUnselect.contextValue}`);
									this._onDidChangeTreeData.fire(toUnselect);
								}, 50);
							}
							this.lastSelectedNode = event.selection[0];
							this.lastSelectedNode.contextValue = "selected";
							const toSelect = this.lastSelectedNode;
							setTimeout(() => {
								//console.log(`smartLogTreeView.onDidChangeSelection selecting ${toSelect.id} ${toSelect.contextValue}`);
								this._onDidChangeTreeData.fire(toSelect);
							}, 50);

							if (event.selection[0].uri.fragment.length > 0) {
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
						}
					}));
				}
			}
		}
	}

	public async provideHover(doc: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | null> {
		const posTime = await this.provideTime(doc, position);
		if (posTime && posTime.valueOf() > 0) {
			//const timePos = this.providePositionCloseTo(doc, posTime);
			return new vscode.Hover({ language: "smart-log", value: `calculated time: ${posTime.toLocaleTimeString()}.${posTime.valueOf() % 1000} line#=${position.line}` }); // posCloseTo=${timePos?.line}` });
		}
		console.warn(`smart-log.provideHover: can't determine time for position.line=${position.line} posTime=${posTime?.valueOf()}`);
		return null;
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

	async provideTime(doc: vscode.TextDocument, pos: vscode.Position): Promise<Date> {
		// console.log(`smart-log.provideTime(doc=${doc.uri.toString()}, pos.line=${pos.line}})`);
		let data = this._documents.get(doc.uri.toString());
		if (data) {
			return this.provideTimeByData(data, pos.line);
		} else {
			console.log("smart-log.provideTime called for an unknown/unhandled document!");
		}
		return new Date(0);
	}

	provideTimeByDataSync(data: DataPerDocument, line: number): Date | undefined {
		// console.log(`smart-log.provideTime(doc=${doc.uri.toString()}, pos.line=${pos.line}})`);
		// we do want only cached times:
		if (data.cachedTimes && line < data.cachedTimes.length) {
			const toRet = data.cachedTimes[line];
			if (data.timeAdjustMs) {
				return new Date(toRet.valueOf() + data.timeAdjustMs);
			} else {
				return toRet;
			}
		}
		// we trigger it
		console.log(`smart-log.provideTimeByDataSync(cachedTimes=${data.cachedTimes?.length}), pos.line=${line}}) not in cache!`);
		this.provideTimeByData(data, line);
		// but return instantly an undefined
		return undefined;
	}

	async provideTimeByData(data: DataPerDocument, line: number): Promise<Date> {
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

			console.log(`smart-log.provideTimeByData regenerating cachedTimes. line=${line}/${data.doc.lineCount} vs. cachedTimes.lines=${data.cachedTimes?.length}`);

			// we reset the times here in any case:
			// there is a race cond here that this function gets called multiple times (as the function calls sleep...)
			// so as hotfix we do change the cachedTimes array only once all calculated.
			// proper fix pending.
			data.cachedTimes = undefined;

			return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true }, async (progress, cancelToken): Promise<Date> => {


				let cachedTimes = new Array<Date>();

				// calc times for full document here (we could calc only for 0-pos.line...)
				//  for each line provide time from current or lines above that have a time.
				let startTime = process.hrtime();
				for (let i = 0; i < data.doc.lineCount; ++i) {
					if (i % 1000 === 0) { // provide process and responsiveness for UI:
						if (cancelToken.isCancellationRequested) {
							return new Date(0);
						}
						let curTime = process.hrtime(startTime);
						if (curTime[1] / 1000000 > 100) { // 100ms passed
							if (progress) {
								progress.report({ message: `processed ${i}/${data.doc.lineCount} lines.` });
							}
							await util.sleep(10); // 10ms each 100ms
							startTime = process.hrtime();
						}
					}
					let curDate = this.parseDateForLine(data, i);
					if (curDate !== undefined) {
						cachedTimes.push(curDate);
					}
					else {
						// use the one from prev. line
						if (i > 0) {
							cachedTimes.push(cachedTimes[i - 1]);
						} else {
							cachedTimes.push(new Date(0));
						}
					}
				}
				data.cachedTimes = cachedTimes;
				console.log(`smart-log.provideTime calculated all times. (lines=${data.cachedTimes.length})`);
				const toRet = data.cachedTimes[line];
				if (data.timeAdjustMs) {
					return new Date(toRet.valueOf() + data.timeAdjustMs);
				} else {
					return toRet;
				}
			});
		}
	}

	public parseDateForLine(data: DataPerDocument, line: number): Date | undefined {
		// assumes that data.timeRegex and data.d3TimeParser is set accordingly
		let curLine = data.doc.lineAt(line).text;
		let regRes = curLine.match(data.timeRegex!);
		if (regRes) {
			if (regRes.length >= 7) {
				let year = +regRes[1];
				if (year < 100) { year += 2000; }
				const ms: number = regRes[7] ? +regRes[7] : 0;
				let date = new Date(year, +regRes[2] - 1, +regRes[3], +regRes[4], +regRes[5], +regRes[6], ms);
				return date;
			} else if (regRes.length === 2) { // one complete date string
				let date: Date | null = null;
				if (data.d3TimeParser !== undefined) {
					try {
						const parsedTime = data.d3TimeParser(regRes[1]);
						// console.log(`got parsedTime ${parsedTime}`);
						date = <Date>parsedTime;
					} catch (error) {
						console.log(`got error ${error}`);
					}
				} else {
					date = new Date(regRes[1]);
				}
				return date ? date : undefined;
			}
		}
		return undefined;
	}

	public providePositionCloseTo(doc: vscode.TextDocument, date: Date): vscode.Position | undefined {
		console.log(`smart-log.providePositionCloseTo(doc=${doc.uri.toString()}) :`, date);
		let data = this._documents.get(doc.uri.toString());
		if (data) {
			// todo do binary search (difficulty === doesnt work >= and prev line <)
			for (let i = 0; i < data.doc.lineCount; ++i) {
				const lineTime: Date | undefined = this.provideTimeByDataSync(data, i);
				if (lineTime !== undefined) {
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
			}
			return undefined;
		} else {
			console.log(" called for an unknown/unhandled document!");
		}
		return undefined;
	}

	broadcastTimeSyncs(data: DataPerDocument) {
		if (data.timeSyncs?.length) {
			// console.log(` smart-log posting time update ${time.toLocaleTimeString()}.${String(time.valueOf() % 1000).padStart(3, "0")}`);
			let timeSyncs = [];
			for (let i = 0; i < data.timeSyncs.length; ++i) {
				const timeSyncEvent = data.timeSyncs[i];
				timeSyncs.push(timeSyncEvent[1]);
			}
			console.log(`broadcasting ${timeSyncs.length} time syncs via onDidChangeSelectedTime`);
			this._onDidChangeSelectedTime.fire({ time: new Date(0), uri: data.doc.uri, timeSyncs: timeSyncs });
		}
	}

	/*
	 * decorations support
	 */
	async updateData(data: DataPerDocument) {
		console.log(`smart-log.updateData(document.uri=${data.doc.uri.toString()})...`);
		const doc = data.doc;
		const text = doc.getText();
		let match;

		// identify file config. The first matching one will be used:
		// we could cache the one here! (todo and then reset cached one on config update)
		let identifiedFileConfig: any | undefined = data.identifiedFileConfig;
		if (!identifiedFileConfig) {
			if (this._fileConfigs) {
				let matchAccurracy = -1;
				const nrLines = doc.lineCount > 100 ? 100 : doc.lineCount;
				for (let i = 0; i < this._fileConfigs.length; ++i) {
					const fileConfig: any = this._fileConfigs[i];
					try {
						const name: string = fileConfig.name;
						const identifyRegexStr: string = fileConfig.identifyRegex;
						console.log(` checking fileConfig ${name} with identifyRegex ${identifyRegexStr}`);
						if (name && identifyRegexStr) {
							const identifyRegex: RegExp = new RegExp(identifyRegexStr);
							if (identifyRegex.exec(doc.getText())) {
								//console.log(` fileConfig ${name} matches!`);
								// have to set timeRegex and timeFormat and d3TimeParser already here for parseDateForLine
								data.timeRegex = ("timeRegex" in fileConfig) ? new RegExp(<string>fileConfig.timeRegex) : this._timeRegex;
								data.timeFormat = ("timeFormat" in fileConfig) ? fileConfig.timeFormat : this._timeFormat;
								data.d3TimeParser = data.timeFormat ? d3.timeParse(data.timeFormat) : undefined;
								// lets see how accurate it matches by determining how many
								// times we can get from the first 100 lines:
								let linesWithDate = 0;
								for (let l = 0; l < nrLines; ++l) {
									if (this.parseDateForLine(data, l) !== undefined) { linesWithDate++; }
								}
								console.log(` fileConfig ${name} matches with accurracy=${linesWithDate}`);
								if (linesWithDate > matchAccurracy) {
									identifiedFileConfig = fileConfig;
									matchAccurracy = linesWithDate;
								}
								if (matchAccurracy > 50) { // good enough, lets keep this
									break;
								}
							}
						}
					} catch (error) {
						console.log(`  error:${error}`);
					}
				}
			}
		}

		data.timeSyncs = []; // reset them here.

		if (identifiedFileConfig) {
			// need to reset here as above the not most accurate match might be checked...
			data.timeRegex = ("timeRegex" in identifiedFileConfig) ? new RegExp(<string>identifiedFileConfig.timeRegex) : this._timeRegex;
			data.timeFormat = ("timeFormat" in identifiedFileConfig) ? identifiedFileConfig.timeFormat : this._timeFormat;
			data.d3TimeParser = data.timeFormat ? d3.timeParse(data.timeFormat) : undefined;

			const events: any | undefined = identifiedFileConfig.events;
			// create the RegExps here to have them compiled and not created line by line
			let rEvents = new Array<{ regex: RegExp, label: string, level: number, decorationId?: string, timeSyncId?: string, timeSyncPrio?: number, icon?: vscode.ThemeIcon }>();
			if (events) {
				for (let i = 0; i < events.length; ++i) {
					const event: any | undefined = events[i];
					if (event.regex) { // level, label, icon and decorationId are optional
						rEvents.push({ regex: new RegExp(event.regex), label: event.label, level: event.level ? event.level : 0, decorationId: event.decorationId, timeSyncId: event.timeSyncId, timeSyncPrio: event.timeSyncPrio, icon: event.icon ? new vscode.ThemeIcon(event.icon) : undefined });
					}
				}
			}

			console.log(` identifiedFileConfig ${identifiedFileConfig.name} matches with ${rEvents.length} events`);

			let eventRoot: EventNode = { id: util.createUniqueId(), label: `${identifiedFileConfig.name}:${path.basename(doc.uri.fsPath)}`, uri: doc.uri, parent: null, children: [] };
			let decorations = new Map<vscode.TextEditorDecorationType, vscode.DecorationOptions[]>();

			function getParent(level: number): EventNode {
				if (level === 1) {
					return eventRoot;
				} else {
					const parent = getParent(level - 1);
					if (parent.children.length === 0) {
						// create a dummy and return that one:
						parent.children.push({ id: util.createUniqueId(), label: `(no parent level ${level - 1} event)`, uri: doc.uri, parent: parent, children: [] }); // todo add line number?
					}
					return parent.children[parent.children.length - 1];
				}
			}

			return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification }, async (progress) => {
				try {
					if (rEvents.length) {
						let startTime = process.hrtime();
						for (let i = 0; i < doc.lineCount; ++i) {
							let curTime = process.hrtime(startTime);
							if (curTime[1] / 1000000 > 100) { // 100ms passed
								if (progress) {
									progress.report({ message: `decorated ${i}/${data.doc.lineCount} lines.` });
								}
								await util.sleep(10); // 10ms each 100ms
								startTime = process.hrtime();
							}
							const line = doc.lineAt(i);

							// scan for event matches: (in sequence due to level, so sadly not in parallel...)
							for (let j = 0; j < rEvents.length; ++j) {
								const ev = rEvents[j];
								if (match = ev.regex.exec(line.text)) {
									let label: string = ev.label ? util.stringFormat(ev.label, match) : `${match[0]}`;
									if (ev.level > 0) {
										const parentNode = getParent(ev.level);
										parentNode.children.push({ id: util.createUniqueId(), label: label, uri: doc.uri.with({ fragment: `${line.lineNumber}` }), parent: parentNode, children: [], icon: ev.icon });
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
									if (ev.timeSyncId && ev.timeSyncPrio) {
										console.log(` found timeSyncId(${ev.timeSyncId}) with value '${match[match.length - 1].toLowerCase()}'`);
										data.timeSyncs.push([line.lineNumber, { id: ev.timeSyncId, value: match[match.length - 1].toLowerCase(), time: await this.provideTimeByData(data, line.lineNumber), prio: ev.timeSyncPrio }]);
									}
								}
							}
						}
					}
				} catch (error) {
					console.log(`error: ${error} occurred!`);
				}
				const doReveal = !data.eventTreeNode;
				data.eventTreeNode = eventRoot;

				data.decorations = new Array<[vscode.TextEditorDecorationType, Array<vscode.DecorationOptions>]>();
				decorations.forEach((value, key) => { // todo if a prev. DecorationType is missing it's not set!
					data.decorations?.push([key, value]);
				});

				// if we have time sync events broadcast them:
				this.broadcastTimeSyncs(data);
				this.checkActiveTextEditor(data);
				this.updateDecorations(data);
				// we fire here the event as well to update the tree:
				this._onDidChangeTreeData.fire();
				this._onDidChangeTreeData.fire(data.eventTreeNode);
				if (doReveal) { this._smartLogTreeView?.reveal(data.eventTreeNode, { select: false, focus: false, expand: false }); }

				// start generating the cache here:
				this.provideTimeByData(data, data.doc.lineCount - 1);

			});


		} else {
			console.log(`smart-log.updateData(document.uri=${data.doc.uri.toString()}) has no data!`);
			// no config
			data.eventTreeNode = undefined;
			data.decorations = undefined; // this won't delete the old ones! todo
			this.checkActiveTextEditor(data);
			this.updateDecorations(data);
			// we fire here the event as well to update the tree:
			this._onDidChangeTreeData.fire();
		}
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
			id: element.id,
			label: element.label.length ? element.label : "<no events>",
			collapsibleState: element.children.length ? vscode.TreeItemCollapsibleState.Collapsed : void 0,
			contextValue: element.contextValue,
			iconPath: element.icon
		};
	}

	public getChildren(element?: EventNode): EventNode[] | Thenable<EventNode[]> {
		// console.log(`smart-log.getChildren(${element?.label}, ${element?.uri?.toString()}) this=${this} called.`);
		if (!element) { // if no element we have to return the root elements.
			let nodeArray: EventNode[] = [];
			this._documents.forEach((data) => { if (data.eventTreeNode) { nodeArray.push(data.eventTreeNode); } });
			return nodeArray;
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
		this._documents.forEach((data) => {
			if (data.doc.uri.toString() !== ev.uri.toString()) {
				if (ev.time.valueOf() > 0) {
					console.log(` trying to reveal ${ev.time.toLocaleTimeString()} at doc ${data.doc.uri.toString()}`);
					// store the last received time to be able to us this for the adjustTime command as reference:
					data.lastSelectedTimeEv = ev.time;

					let position = this.providePositionCloseTo(data.doc, ev.time);
					if (position && data.textEditors) {
						const posRange = new vscode.Range(position, position);
						data.textEditors.forEach((value) => {
							value.revealRange(posRange, vscode.TextEditorRevealType.AtTop);
							// todo add/update decoration as well
						});
					}
				}
				if (ev.timeSyncs?.length && data.timeSyncs.length) {
					console.log(` got ${ev.timeSyncs.length} timeSyncs from ${ev.uri.toString()}`);
					// todo auto timesync... 
					let adjustTimeBy: number[] = [];
					let reBroadcastEvents: TimeSyncData[] = [];

					// compare with our known timesyncs.
					for (let i = 0; i < ev.timeSyncs.length; ++i) {
						const remoteSyncEv = ev.timeSyncs[i];
						console.log(`  got id='${remoteSyncEv.id}' with value='${remoteSyncEv.value} at ${remoteSyncEv.time.toLocaleTimeString()}`);
						// do we have this id? (optimize with maps... for now linear (search))
						for (let j = 0; j < data.timeSyncs.length; ++j) {
							const localSyncLineEv = data.timeSyncs[j];
							const localSyncEv = localSyncLineEv[1];
							if (remoteSyncEv.id === localSyncEv.id) {
								console.log(`  got id='${remoteSyncEv.id}' match. Checking value='${remoteSyncEv.value} at ${remoteSyncEv.time.toLocaleTimeString()}`);
								if (remoteSyncEv.value === localSyncEv.value) {
									console.log(`   got id='${remoteSyncEv.id}',prio=${remoteSyncEv.prio} and value='${remoteSyncEv.value} match at ${remoteSyncEv.time.toLocaleTimeString()} with local line ${localSyncLineEv[0]}, prio=${localSyncEv.prio}`);
									// todo! (what to do now? how to decide whether to adjust here (and not on the other side...))
									// if the received prio is lower we adjust our time... // todo consider 3 documents...
									// otherwise we broadcast all values with a lower prio than the current received ones...
									if (remoteSyncEv.prio < localSyncEv.prio) {
										adjustTimeBy.push(remoteSyncEv.time.valueOf() - localSyncEv.time.valueOf());
									} else if (remoteSyncEv.prio > localSyncEv.prio) {
										reBroadcastEvents.push(localSyncEv);
									}
								}
							}
						}
					}
					let didTimeAdjust = false;
					if (adjustTimeBy.length) {
						const minAdjust = Math.min(...adjustTimeBy);
						const maxAdjust = Math.max(...adjustTimeBy);
						const avgAdjust = adjustTimeBy.reduce((a, b) => a + b, 0) / adjustTimeBy.length;
						console.log(`have ${adjustTimeBy.length} time adjustments with min=${minAdjust}, max=${maxAdjust}, avg=${avgAdjust} ms.`);
						if (Math.abs(avgAdjust) > 100) {
							data.gotTimeSyncEvents = true;
							this.adjustTime(data, avgAdjust);
							didTimeAdjust = true;
						}

					}
					if (!didTimeAdjust && reBroadcastEvents.length) {
						console.log(`re-broadcasting ${reBroadcastEvents.length} time syncs via onDidChangeSelectedTime`);
						this._onDidChangeSelectedTime.fire({ time: new Date(0), uri: data.doc.uri, timeSyncs: reBroadcastEvents });
					}
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
		this._didChangeSelectedTimeSubscriptions = [];

		let newSubs = new Array<vscode.Disposable>();

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
							console.log(`smart-log.got onDidChangeSelectedTime api from ${value.id}`);
							newSubs.push(subscr);
						}
					}
				} catch (error) {
					console.log(`smart-log:extension ${value.id} throws: ${error}`);
				}
			}
		});
		this._didChangeSelectedTimeSubscriptions = newSubs;
		console.log(`smart-log.checkActiveExtensions: got ${this._didChangeSelectedTimeSubscriptions.length} subscriptions.`);
	}

	// provide text docs fom event tree:
	provideTextDocumentContent(uri: vscode.Uri): string {
		const parts = util.unparseUri(uri);
		console.log(`got args=${JSON.stringify(parts.args)}`);
		console.log(`got args.uri=${JSON.stringify(parts.args.uri)}`);

		let nodeUri = vscode.Uri.parse(parts.args.uri.external).with({
			scheme: parts.args.uri.scheme,
			query: parts.args.uri.query,
			path: parts.args.uri.path,
			fragment: parts.args.uri.fragment,
			authority: parts.args.uri.authority

		});

		// do we know this doc?
		const data = this._documents.get(nodeUri.with({ fragment: '' }).toString());
		if (data) {

			if (data.eventTreeNode) {

				// determine start node by nodeId:
				const nodeId = parts.args.nodeId;
				let startNode: EventNode | undefined = data.eventTreeNode;
				if (nodeId) {
					startNode = findNodeById(startNode, nodeId);
				}
				if (startNode) {
					console.log(`iterateDepth startNode: ${startNode.label}`);
					let toRet: string = `${startNode.uri?.fsPath}${(startNode !== data.eventTreeNode) ? ` for event '${startNode.label}'` : ''}\n`;
					iterateDepth(startNode, (node, relLevel): boolean => {
						try {
							toRet += '\t'.repeat(relLevel);
							toRet += `${node.label}\n`;
						} catch (err) {
							console.log(`iterateDepth got err '${err}' at node: ${node.label}`);
						}
						return false;
					});
					return toRet;
				} else {
					return `start event not found for uri=${nodeUri.toString()} nodeId=${nodeId}`;
				}
			} else {
				return `no events from uri=${nodeUri.toString()}`;
			}
		} else {
			return `unknown doc from uri=${nodeUri.toString()}`;
		}
	}

}

function iterateDepth(startNode: EventNode, func: ((node: EventNode, relLevel: number) => boolean), startLevel: number = 0): EventNode | undefined {

	if (func(startNode, startLevel)) { return startNode; }

	for (let i = 0; i < startNode.children.length; ++i) {
		const child = startNode.children[i];
		const retChild = iterateDepth(child, func, startLevel + 1);
		if (retChild !== undefined) { return retChild; }
	}
	return undefined;
}

function findNodeById(startNode: EventNode, id: string): EventNode | undefined {
	return iterateDepth(startNode, (node: EventNode): boolean => {
		if (node.id === id) { return true; }
		return false;
	});
}