/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React from 'react'
import { OrbitAuthPanel } from './OrbitAuthPanel.js'

export const AccountSection = () => (
	<>
		<div className='@@settings-page-header'>
			<h2 className='@@settings-page-title'>Account</h2>
			<div className='@@settings-page-desc'>
				Sign in with GitHub to use Orbit Provider models. Billing and usage are managed on the Orbit website.
			</div>
		</div>

		<div className='@@settings-card'>
			<div className='@@settings-card-body'>
				<OrbitAuthPanel />
			</div>
		</div>
	</>
)
