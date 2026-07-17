/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { InternalToolInfo } from '../../common/prompt/prompts.js'
import type { JsonToolSchema } from '../../common/sendLLMMessageTypes.js'

/** OpenAI-compatible JSON Schema for a tool — prefers inputSchema over legacy params. */
export const schemaOfToolInfo = (toolInfo: InternalToolInfo): JsonToolSchema => {
	if (toolInfo.inputSchema) {
		return toolInfo.inputSchema as JsonToolSchema
	}
	const paramsWithType: { [s: string]: { description: string; type: 'string' } } = {}
	for (const key in toolInfo.params) {
		paramsWithType[key] = { ...toolInfo.params[key], type: 'string' }
	}
	return {
		type: 'object',
		properties: paramsWithType,
	}
}
