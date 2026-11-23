import path from 'node:path'
import type { NextConfig } from 'next'

// The monorepo root: Turbopack resolves the workspace packages from there, and the Docker image's
// standalone build traces from there so packages/shared and the hoisted node_modules land in it.
const root = path.join(__dirname, '../..')

const config: NextConfig = {
	// apps/web/Dockerfile sets NEXT_OUTPUT=standalone and runs the standalone server.js.
	...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const, outputFileTracingRoot: root } : {}),
	turbopack: { root },
	transpilePackages: ['@mailroom/shared'],
	poweredByHeader: false,
	async headers() {
		return [
			{
				source: '/:path*',
				headers: [
					{ key: 'X-Frame-Options', value: 'DENY' },
					{ key: 'X-Content-Type-Options', value: 'nosniff' },
					{ key: 'Referrer-Policy', value: 'no-referrer' },
				],
			},
		]
	},
}

export default config
