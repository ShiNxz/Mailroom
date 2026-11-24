'use client'

import { isAdminRole } from '@mailroom/shared'
import { ShieldAlert } from 'lucide-react'
import { BrandingSettings } from '@/components/settings/Branding'
import { EmptyState } from '@/components/ui'
import { useMe } from '@/lib/api'

export default function BrandingSettingsPage() {
	const { data: me } = useMe()
	if (!me) return null
	if (!isAdminRole(me.user.role))
		return (
			<EmptyState icon={<ShieldAlert />} title="Admins only">
				Ask an admin to change the branding.
			</EmptyState>
		)
	return <BrandingSettings />
}
