import { Disposable, IReference } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { FileOperationError, FileOperationResult } from '../../../../platform/files/common/files.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';

type VoidModelType = {
	model: ITextModel | null;
	editorModel: IResolvedTextEditorModel | null;
};

export interface IVoidModelService {
	readonly _serviceBrand: undefined;
	initializeModel(uri: URI): Promise<void>;
	getModel(uri: URI): VoidModelType;
	getModelFromFsPath(fsPath: string): VoidModelType;
	getModelSafe(uri: URI): Promise<VoidModelType>;
	saveModel(uri: URI): Promise<void>;

}

export const IVoidModelService = createDecorator<IVoidModelService>('voidVoidModelService');

class VoidModelService extends Disposable implements IVoidModelService {
	_serviceBrand: undefined;
	static readonly ID = 'voidVoidModelService';
	private readonly _modelRefOfURI: Record<string, IReference<IResolvedTextEditorModel>> = {};

	constructor(
		@ITextModelService private readonly _textModelService: ITextModelService,
		@ITextFileService private readonly _textFileService: ITextFileService,
	) {
		super();
	}

	saveModel = async (uri: URI) => {
		await this._textFileService.save(uri, { // we want [our change] -> [save] so it's all treated as one change.
			skipSaveParticipants: true // avoid triggering extensions etc (if they reformat the page, it will add another item to the undo stack)
		})
	}

	/** Prefer uri.toString() as the cache key (stable across schemes); keep fsPath alias for callers. */
	private _key(uri: URI): string {
		return uri.toString();
	}

	initializeModel = async (uri: URI) => {
		const key = this._key(uri);
		const fsKey = uri.fsPath;
		if (key in this._modelRefOfURI || fsKey in this._modelRefOfURI) {
			return;
		}
		try {
			const editorModelRef = await this._textModelService.createModelReference(uri);
			this._modelRefOfURI[key] = editorModelRef;
			// Legacy alias so getModelFromFsPath still works.
			this._modelRefOfURI[fsKey] = editorModelRef;
		} catch (e) {
			// Optional workspace files (e.g. `.orbitrules`) are often absent — treat as a
			// no-op so startup contributions don't throw unhandled rejections.
			if (e instanceof FileOperationError && e.fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
				return;
			}
			throw e;
		}
	};

	getModelFromFsPath = (fsPath: string): VoidModelType => {
		const editorModelRef = this._modelRefOfURI[fsPath];
		if (!editorModelRef) {
			return { model: null, editorModel: null };
		}

		const model = editorModelRef.object.textEditorModel;

		if (!model) {
			return { model: null, editorModel: editorModelRef.object };
		}

		return { model, editorModel: editorModelRef.object };
	};

	getModel = (uri: URI) => {
		const byUri = this._modelRefOfURI[this._key(uri)];
		if (byUri) {
			const model = byUri.object.textEditorModel;
			return { model: model ?? null, editorModel: byUri.object };
		}
		return this.getModelFromFsPath(uri.fsPath);
	}


	getModelSafe = async (uri: URI): Promise<VoidModelType> => {
		const key = this._key(uri);
		if (!(key in this._modelRefOfURI) && !(uri.fsPath in this._modelRefOfURI)) {
			await this.initializeModel(uri);
		}
		return this.getModel(uri);
	};

	override dispose() {
		super.dispose();
		// Keys may alias the same ref (uri.toString() + fsPath) — dispose once.
		const seen = new Set<IReference<IResolvedTextEditorModel>>();
		for (const ref of Object.values(this._modelRefOfURI)) {
			if (seen.has(ref)) {
				continue;
			}
			seen.add(ref);
			ref.dispose();
		}
	}
}

registerSingleton(IVoidModelService, VoidModelService, InstantiationType.Eager);
