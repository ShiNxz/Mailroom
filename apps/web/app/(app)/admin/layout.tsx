'use client'

import { isAdminRole } from '@mailroom/shared'
import { ShieldAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { EmptyState, Loading } from '@/components/ui'
import { useMe } from '@/lib/api'

export default function AdminLayout({ children }: { children: ReactNode }) {
	const { data: me } = useMe()
	if (!me) return <Loading />
	if (!isAdminRole(me.user.role))
		return (
			<EmptyState icon={<ShieldAlert />} title="Admins only">
				Ask an admin for access.
			</EmptyState>
		)
	return children
}
