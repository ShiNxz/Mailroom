'use client'

import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import { type Editor as TiptapEditor, EditorContent, useEditor, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Bold, Italic, Link2, List, ListOrdered, Quote, RemoveFormatting, Strikethrough, Underline } from 'lucide-react'
import { useEffect } from 'react'

/** Rich text editor for mail: bold, italic, underline, links, lists, quotes, pasted images. */
export function MailEditor({
	value,
	onChange,
	placeholder = 'Write your message',
	onReady,
	autoFocus,
	minHeight,
}: {
	value: string
	onChange: (html: string) => void
	placeholder?: string
	onReady?: (editor: TiptapEditor) => void
	autoFocus?: boolean
	minHeight?: number
}) {
	const editor = useEditor({
		immediatelyRender: false,
		extensions: [
			StarterKit.configure({
				link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } },
				heading: { levels: [2, 3] },
			}),
			Image.configure({ allowBase64: true, inline: true }),
			Placeholder.configure({ placeholder }),
		],
		content: value,
		autofocus: autoFocus ? 'start' : false,
		onUpdate: ({ editor }) => onChange(editor.isEmpty ? '' : editor.getHTML()),
		editorProps: {
			attributes: { class: 'mr-editor-content', style: minHeight ? `min-height:${minHeight}px` : '' },
			// Pasted image files become inline data: images (sent as embedded attachments)
			handlePaste: (view, event) => {
				const files = [...(event.clipboardData?.files ?? [])].filter(f => f.type.startsWith('image/'))
				if (!files.length) return false
				for (const file of files) {
					if (file.size > 5 * 1024 * 1024) continue
					const reader = new FileReader()
					reader.onload = () => {
						const node = view.state.schema.nodes.image?.create({ src: reader.result as string })
						if (node) view.dispatch(view.state.tr.replaceSelectionWith(node))
					}
					reader.readAsDataURL(file)
				}
				return true
			},
		},
	})

	useEffect(() => {
		if (editor && onReady) onReady(editor)
	}, [editor])

	return (
		<div className="mr-editor flex min-h-0 flex-1 flex-col">
			{editor && <Toolbar editor={editor} />}
			<EditorContent editor={editor} className="min-h-0 flex-1 overflow-y-auto px-4 py-3" />
		</div>
	)
}

function Toolbar({ editor }: { editor: TiptapEditor }) {
	const state = useEditorState({
		editor,
		selector: ({ editor: e }) => ({
			bold: e.isActive('bold'),
			italic: e.isActive('italic'),
			underline: e.isActive('underline'),
			strike: e.isActive('strike'),
			bullet: e.isActive('bulletList'),
			ordered: e.isActive('orderedList'),
			quote: e.isActive('blockquote'),
			link: e.isActive('link'),
		}),
	})
	const btn = (label: string, active: boolean, run: () => void, icon: React.ReactNode) => (
		<button
			type="button"
			title={label}
			aria-label={label}
			aria-pressed={active}
			onMouseDown={e => {
				e.preventDefault()
				run()
			}}
			className={`flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-default hover:text-foreground ${active ? 'bg-default text-foreground' : ''}`}
		>
			{icon}
		</button>
	)
	const chain = () => editor.chain().focus()
	return (
		<div className="flex flex-wrap items-center gap-0.5 border-b border-separator px-2 py-1 [&_svg]:size-4">
			{btn('Bold', state.bold, () => chain().toggleBold().run(), <Bold />)}
			{btn('Italic', state.italic, () => chain().toggleItalic().run(), <Italic />)}
			{btn('Underline', state.underline, () => chain().toggleUnderline().run(), <Underline />)}
			{btn('Strikethrough', state.strike, () => chain().toggleStrike().run(), <Strikethrough />)}
			<span className="mx-1 h-4 w-px bg-separator" />
			{btn('Bulleted list', state.bullet, () => chain().toggleBulletList().run(), <List />)}
			{btn('Numbered list', state.ordered, () => chain().toggleOrderedList().run(), <ListOrdered />)}
			{btn('Quote', state.quote, () => chain().toggleBlockquote().run(), <Quote />)}
			{btn(
				'Link',
				state.link,
				() => {
					if (state.link) return chain().unsetLink().run()
					const url = window.prompt('Link address')
					if (!url) return
					const href = /^(https?:|mailto:)/i.test(url) ? url : `https://${url}`
					chain().extendMarkRange('link').setLink({ href }).run()
				},
				<Link2 />,
			)}
			{btn('Clear formatting', false, () => chain().unsetAllMarks().clearNodes().run(), <RemoveFormatting />)}
		</div>
	)
}
