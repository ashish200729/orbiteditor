import { useCallback, useEffect, useRef, useState } from 'react'

// Re-export the pop-out window/document resolvers (defined in a JSX-free module so `.ts` files can
// import them too) for convenient co-location with the other React helpers.
export { getConnectedDocument, getConnectedWindow, focusInConnectedWindow, findThreadComposerInWindow } from './connectedWindow.js'



type ReturnType<T> = [
	{ readonly current: T },
	(t: T) => void
]

// use this if state might be too slow to catch
export const useRefState = <T,>(initVal: T): ReturnType<T> => {
	// this actually makes a difference being an int, not a boolean.
	// if it's a boolean and changes happen to fast, it goes with old values and leads to *very* weird bugs (like returning JSX, but not actually rendering it)
	const [_s, _setState] = useState(0)

	const ref = useRef<T>(initVal)
	const setState = useCallback((newVal: T) => {
		_setState(n => n + 1) // call rerender
		ref.current = newVal
	}, [])
	return [ref, setState]
}


export const usePromise = <T,>(promise: Promise<T>): T | undefined => {
	const [val, setVal] = useState<T | undefined>(undefined)
	useEffect(() => {
		promise.then((v) => setVal(v))
	}, [promise])
	return val
}


/**
 * Downscale/re-encode an image data URL before it enters thread state. Full-res
 * screenshots otherwise get stored as base64 in thread state + storage and re-sent
 * on every LLM request. Caps the largest dimension and re-encodes to JPEG. Images
 * already within bounds are returned unchanged (preserves PNG transparency). Never
 * rejects — falls back to the original data URL on any failure.
 */
export const downscaleImageDataUrl = (
	dataUrl: string,
	maxDim = 1568,
	quality = 0.8,
): Promise<string> => {
	return new Promise<string>((resolve) => {
		try {
			const img = new Image()
			img.onload = () => {
				const w = img.naturalWidth
				const h = img.naturalHeight
				if (!w || !h) { resolve(dataUrl); return }
				const scale = Math.min(1, maxDim / Math.max(w, h))
				// Already small enough: keep original bytes rather than force a JPEG re-encode.
				if (scale >= 1) { resolve(dataUrl); return }
				const canvas = document.createElement('canvas')
				canvas.width = Math.round(w * scale)
				canvas.height = Math.round(h * scale)
				const ctx = canvas.getContext('2d')
				if (!ctx) { resolve(dataUrl); return }
				ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
				resolve(canvas.toDataURL('image/jpeg', quality))
			}
			img.onerror = () => resolve(dataUrl)
			img.src = dataUrl
		} catch {
			resolve(dataUrl)
		}
	})
}
