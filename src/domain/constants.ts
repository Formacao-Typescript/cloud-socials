import { Element } from '../deps.ts'

export const SOCIAL_CARD_META_TAGS = [
	{
		selector: 'meta[property="og:title"]',
		name: 'title',
		priority: 2,
		value: (el: Element) => el.getAttribute('content'),
	},
	{
		selector: 'meta[property="og:description"]',
		name: 'description',
		priority: 2,
		value: (el: Element) => el.getAttribute('content'),
	},
	{
		selector: 'meta[property="og:image"]',
		name: 'thumbnail',
		priority: 2,
		value: (el: Element) => el.getAttribute('content'),
	},
	{
		selector: 'meta[name="twitter:title"]',
		name: 'title',
		priority: 1,
		value: (el: Element) => el.getAttribute('content'),
	},
	{
		selector: 'meta[name="twitter:description"]',
		name: 'description',
		priority: 1,
		value: (el: Element) => el.getAttribute('content'),
	},
	{
		selector: 'meta[name="twitter:image"]',
		name: 'thumbnail',
		priority: 1,
		value: (el: Element) => el.getAttribute('content'),
	},
	{
		selector: 'title',
		name: 'title',
		priority: 3,
		value: (el: Element) => el.textContent,
	},
].sort((a, b) => a.priority - b.priority)
