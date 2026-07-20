/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { IProductService } from '../../../../../platform/product/common/productService.js'
import { INativeEnvironmentService } from '../../../../../platform/environment/common/environment.js'

export function getOrbitApiBaseUrl(
	productService: IProductService,
	environmentService: INativeEnvironmentService,
): string {
	// ORBIT_API_URL is for local development only — never honor it in release builds.
	if (!environmentService.isBuilt && process.env.ORBIT_API_URL) {
		return process.env.ORBIT_API_URL.replace(/\/$/, '')
	}
	// Dev builds (./scripts/code.sh) use orbitApiUrlDev from product.json.
	// Override with ORBIT_API_URL=http://localhost:4000 for a local backend.
	if (!environmentService.isBuilt) {
		return (productService.orbitApiUrlDev ?? 'https://api.orbiteditorai.com').replace(/\/$/, '')
	}
	if (productService.orbitApiUrl) {
		return productService.orbitApiUrl.replace(/\/$/, '')
	}
	return 'https://api.orbiteditorai.com'
}
