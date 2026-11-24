import { Card } from '@heroui/react'
import type { ReactNode } from 'react'

export function Section({
	title,
	description,
	action,
	children,
}: {
	title: ReactNode
	description?: ReactNode
	action?: ReactNode
	children: ReactNode
}) {
	return (
		<Card>
			<Card.Header className="flex-row items-start justify-between gap-3">
				<div className="flex flex-col gap-1">
					<Card.Title>{title}</Card.Title>
					{description && <Card.Description>{description}</Card.Description>}
				</div>
				{action}
			</Card.Header>
			<Card.Content className="flex flex-col gap-4">{children}</Card.Content>
		</Card>
	)
}
