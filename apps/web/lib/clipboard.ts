'use client'

/**
 * Copies text. Uses the Clipboard API, and falls back to the older select-and-copy where it is refused
 * (some embedded browsers and webviews, pages without focus). Returns whether it worked.
 */
export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text)
		return true
	} catch {}
	// Inside a dialog the helper has to live in the dialog too, or its focus trap pulls focus straight back
	const host = document.activeElement?.closest('[role="dialog"]') ?? document.body
	const area = document.createElement('textarea')
	area.value = text
	area.setAttribute('readonly', '')
	area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none'
	const before = document.activeElement as HTMLElement | null
	host.appendChild(area)
	area.select()
	let ok = false
	try {
		ok = document.execCommand('copy')
	} catch {}
	area.remove()
	before?.focus({ preventScroll: true })
	return ok
}
