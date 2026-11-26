'use client'

import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import type { Node as PMNode } from '@tiptap/pm/model'
import { NodeSelection } from '@tiptap/pm/state'
import type { EditorView, NodeView } from '@tiptap/pm/view'
import { mergeAttributes, type Editor as TiptapEditor, EditorContent, useEditor, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import {
	Bold,
	ImagePlus,
	Italic,
	Link2,
	List,
	ListOrdered,
	Quote,
	RemoveFormatting,
	Strikethrough,
	Trash2,
	Underline,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { imageForMail } from '@/lib/images'

/**
 * Images get width and height attributes (Outlook goes by those) plus max-width and height:auto, so they
 * shrink on a phone instead of stretching. Setting the size from the toolbar restyles the image too; the
 * built-in resize view only follows its own drag handles.
 */
const MailImage = Image.extend({
	renderHTML({ HTMLAttributes }) {
		return [
			'img',
			mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { style: 'max-width:100%;height:auto' }),
		]
	},
	addNodeView() {
		const make = this.parent?.()
		if (!make) return null
		return props => {
			const view = make(props) as NodeView
			const img = (view.dom as HTMLElement).querySelector('img')
			const fit = (node: PMNode) => {
				if (!img) return
				img.style.width = node.attrs.width ? `${node.attrs.width}px` : ''
				img.style.height = ''
			}
			fit(props.node)
			const update = view.update?.bind(view)
			view.update = (node, ...rest) => {
				const ok = update ? update(node, ...rest) : false
				if (ok) fit(node)
				// Saving a dragged size replaces the node, which drops the selection; select it again so the size
				// buttons stay up
				if (ok && (view.dom as HTMLElement).dataset.resizeState === 'true')
					queueMicrotask(() => {
						const pos = props.getPos()
						if (typeof pos === 'number') props.editor.commands.setNodeSelection(pos)
					})
				return ok
			}
			return view
		}
	},
})

interface ImageOptions {
	/** Width new images get, in pixels */
	width: number
	/** Longest side an image is stored at */
	maxSide: number
}

/** Shrinks the files, inserts them (at `pos`, or over the selection) and selects the last one so its size can be set. */
async function insertImages(view: EditorView, files: File[], opts: ImageOptions, pos?: number) {
	for (const file of files) {
		let img: Awaited<ReturnType<typeof imageForMail>>
		try {
			img = await imageForMail(file, opts.maxSide)
		} catch (err) {
			toast.error((err as Error).message)
			continue
		}
		const width = Math.min(img.width, opts.width)
		const height = Math.round((img.height * width) / img.width)
		const node = view.state.schema.nodes.image?.create({ src: img.src, width, height })
		if (!node) return
		let tr = view.state.tr
		let at: number
		if (pos === undefined) {
			tr = tr.replaceSelectionWith(node)
			at = tr.selection.from - node.nodeSize
		} else {
			tr = tr.insert(pos, node)
			at = pos
			pos += node.nodeSize
		}
		try {
			tr = tr.setSelection(NodeSelection.create(tr.doc, at))
		} catch {}
		view.dispatch(tr)
	}
	view.focus()
}

const imageFiles = (list: FileList | null | undefined) => [...(list ?? [])].filter(f => f.type.startsWith('image/'))

/** Rich text editor for mail: bold, italic, underline, links, lists, quotes, and images you can resize. */
export function MailEditor({
	value,
	onChange,
	placeholder = 'Write your message',
	onReady,
	autoFocus,
	minHeight,
	imageWidth = 480,
}: {
	value: string
	onChange: (html: string) => void
	placeholder?: string
	onReady?: (editor: TiptapEditor) => void
	autoFocus?: boolean
	minHeight?: number
	/** Width a newly added image gets, in pixels. Signatures use a smaller one. */
	imageWidth?: number
}) {
	// Kept at twice the width it's shown at (sharp on retina screens), and at least 400px so it can grow
	const images: ImageOptions = { width: imageWidth, maxSide: Math.max(400, imageWidth * 2) }
	const editor = useEditor({
		immediatelyRender: false,
		extensions: [
			StarterKit.configure({
				link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } },
				heading: { levels: [2, 3] },
			}),
			MailImage.configure({
				allowBase64: true,
				inline: true,
				resize: {
					enabled: true,
					directions: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
					minWidth: 16,
					minHeight: 16,
					alwaysPreserveAspectRatio: true,
				},
			}),
			Placeholder.configure({ placeholder }),
		],
		content: value,
		autofocus: autoFocus ? 'start' : false,
		onUpdate: ({ editor }) => onChange(editor.isEmpty ? '' : editor.getHTML()),
		editorProps: {
			attributes: { class: 'mr-editor-content', style: minHeight ? `min-height:${minHeight}px` : '' },
			// Pasted or dropped image files become inline data: images (sent as embedded attachments)
			handlePaste: (view, event) => {
				const files = imageFiles(event.clipboardData?.files)
				if (!files.length) return false
				void insertImages(view, files, images)
				return true
			},
			handleDrop: (view, event, _slice, moved) => {
				const files = imageFiles(event.dataTransfer?.files)
				if (moved || !files.length) return false
				event.preventDefault()
				const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
				void insertImages(view, files, images, at)
				return true
			},
		},
	})

	useEffect(() => {
		if (editor && onReady) onReady(editor)
	}, [editor])

	return (
		<div className="mr-editor flex min-h-0 flex-1 flex-col">
			{editor && <Toolbar editor={editor} onImages={files => void insertImages(editor.view, files, images)} />}
			<EditorContent editor={editor} className="min-h-0 flex-1 overflow-y-auto px-4 py-3" />
		</div>
	)
}

function ToolButton({
	label,
	active,
	run,
	children,
}: {
	label: string
	active?: boolean
	run: () => void
	children: ReactNode
}) {
	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			aria-pressed={active}
			onMouseDown={e => {
				// Keeps the editor's selection
				e.preventDefault()
				run()
			}}
			className={`flex h-7 min-w-7 items-center justify-center rounded-md px-1 text-muted transition-colors hover:bg-default hover:text-foreground ${active ? 'bg-default text-foreground' : ''}`}
		>
			{children}
		</button>
	)
}

function Toolbar({ editor, onImages }: { editor: TiptapEditor; onImages: (files: File[]) => void }) {
	const state = useEditorState({
		editor,
		selector: ({ editor: e }) => {
			const sel = e.state.selection
			const image =
				sel instanceof NodeSelection && sel.node.type.name === 'image'
					? { pos: sel.from, width: Number(sel.node.attrs.width) || null }
					: null
			return {
				bold: e.isActive('bold'),
				italic: e.isActive('italic'),
				underline: e.isActive('underline'),
				strike: e.isActive('strike'),
				bullet: e.isActive('bulletList'),
				ordered: e.isActive('orderedList'),
				quote: e.isActive('blockquote'),
				link: e.isActive('link'),
				image,
			}
		},
	})
	const picker = useRef<HTMLInputElement>(null)
	const chain = () => editor.chain().focus()
	const divider = <span className="mx-1 h-4 w-px bg-separator" />
	return (
		<div className="flex flex-wrap items-center gap-0.5 border-b border-separator px-2 py-1 [&_svg]:size-4">
			<ToolButton label="Bold" active={state.bold} run={() => chain().toggleBold().run()}>
				<Bold />
			</ToolButton>
			<ToolButton label="Italic" active={state.italic} run={() => chain().toggleItalic().run()}>
				<Italic />
			</ToolButton>
			<ToolButton label="Underline" active={state.underline} run={() => chain().toggleUnderline().run()}>
				<Underline />
			</ToolButton>
			<ToolButton label="Strikethrough" active={state.strike} run={() => chain().toggleStrike().run()}>
				<Strikethrough />
			</ToolButton>
			{divider}
			<ToolButton label="Bulleted list" active={state.bullet} run={() => chain().toggleBulletList().run()}>
				<List />
			</ToolButton>
			<ToolButton label="Numbered list" active={state.ordered} run={() => chain().toggleOrderedList().run()}>
				<ListOrdered />
			</ToolButton>
			<ToolButton label="Quote" active={state.quote} run={() => chain().toggleBlockquote().run()}>
				<Quote />
			</ToolButton>
			<ToolButton
				label="Link"
				active={state.link}
				run={() => {
					if (state.link) return chain().unsetLink().run()
					const url = window.prompt('Link address')
					if (!url) return
					const href = /^(https?:|mailto:)/i.test(url) ? url : `https://${url}`
					chain().extendMarkRange('link').setLink({ href }).run()
				}}
			>
				<Link2 />
			</ToolButton>
			<ToolButton label="Add image" run={() => picker.current?.click()}>
				<ImagePlus />
			</ToolButton>
			<ToolButton label="Clear formatting" run={() => chain().unsetAllMarks().clearNodes().run()}>
				<RemoveFormatting />
			</ToolButton>
			<input
				ref={picker}
				type="file"
				accept="image/*"
				multiple
				hidden
				onChange={e => {
					const files = imageFiles(e.target.files)
					e.target.value = ''
					if (files.length) onImages(files)
				}}
			/>
			{state.image && (
				<>
					{divider}
					<ImageSize editor={editor} pos={state.image.pos} width={state.image.width} />
				</>
			)}
		</div>
	)
}

const SIZES = [
	{ label: 'Small', width: 100 },
	{ label: 'Medium', width: 200 },
	{ label: 'Large', width: 400 },
]

/** Size of the selected image: presets, its own size, or an exact width. Height follows the image's proportions. */
function ImageSize({ editor, pos, width }: { editor: TiptapEditor; pos: number; width: number | null }) {
	const imgAt = () => {
		const dom = editor.view.nodeDOM(pos)
		if (dom instanceof HTMLImageElement) return dom
		return dom instanceof HTMLElement ? dom.querySelector('img') : null
	}
	const natural = imgAt()?.naturalWidth || null
	const shown = width ?? imgAt()?.width ?? natural
	const [draft, setDraft] = useState(shown ? String(shown) : '')
	useEffect(() => setDraft(shown ? String(shown) : ''), [shown, pos])

	const apply = (w: number, refocus = true) => {
		if (!Number.isFinite(w) || w <= 0) return setDraft(shown ? String(shown) : '')
		const img = imgAt()
		const next = Math.round(Math.min(1200, Math.max(16, w)))
		const ratio = img?.naturalWidth ? img.naturalHeight / img.naturalWidth : null
		const c = refocus ? editor.chain().focus() : editor.chain()
		// Updating replaces the node and drops the selection, so it's selected again after
		c.setNodeSelection(pos)
			.updateAttributes('image', { width: next, height: ratio ? Math.round(next * ratio) : null })
			.setNodeSelection(pos)
			.run()
		setDraft(String(next))
	}

	return (
		<div className="flex flex-wrap items-center gap-0.5 text-xs">
			{SIZES.map(s => (
				<ToolButton
					key={s.width}
					label={`${s.label}, ${s.width}px wide`}
					active={width === s.width}
					run={() => apply(s.width)}
				>
					<span className="px-1">{s.label}</span>
				</ToolButton>
			))}
			{natural && (
				<ToolButton label={`Its own size, ${natural}px wide`} active={width === natural} run={() => apply(natural)}>
					<span className="px-1">Original</span>
				</ToolButton>
			)}
			<label className="ml-1 flex h-7 items-center gap-1 rounded-md border border-border bg-field px-1.5 text-muted focus-within:border-accent">
				<input
					aria-label="Image width in pixels"
					inputMode="numeric"
					value={draft}
					onChange={e => setDraft(e.target.value.replace(/\D/g, '').slice(0, 4))}
					onKeyDown={e => {
						if (e.key === 'Enter') {
							e.preventDefault()
							apply(Number(draft))
						} else if (e.key === 'Escape') {
							e.preventDefault()
							setDraft(shown ? String(shown) : '')
							editor.commands.focus()
						}
					}}
					onBlur={() => {
						if (draft && Number(draft) !== shown) apply(Number(draft), false)
					}}
					className="w-10 bg-transparent text-right text-foreground tabular-nums outline-none"
				/>
				px
			</label>
			<ToolButton label="Remove image" run={() => editor.chain().focus().setNodeSelection(pos).deleteSelection().run()}>
				<Trash2 />
			</ToolButton>
		</div>
	)
}
