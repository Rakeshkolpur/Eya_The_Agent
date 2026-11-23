import type { PluginManifest } from '../types';

/**
 * LinkedIn, as a plugin over what Eya already does: the person's own signed-in LinkedIn in their own browser (Eya never has the password or a token — they sign in themself), Eya's drafting tools
 * for posts, comments and replies, and the page gate that holds every Post / Comment / Reply to the permission, the daily limits and the person's own yes (social/PublishGate.ts).
 */
export const LINKEDIN_PLUGIN_ID = 'linkedin';

export const LINKEDIN_PLUGIN: PluginManifest = {
  id: LINKEDIN_PLUGIN_ID,
  name: 'LinkedIn',
  description: "Write posts (with a first line, hashtags and a picture), comments on other people's posts and replies to comments on yours — in your own LinkedIn in your own browser. Eya shows you the exact text and publishes only after your yes.",
  version: '1.0.0',
  author: 'Eya',
  compat: { minEya: '0.1.0' },
  bundled: true,
  auth: {
    kind: 'none',
    describe: 'You sign in to LinkedIn in your own browser yourself. Eya never has your password and never publishes without your yes.',
  },
  permissions: [
    { id: 'drafts.write', label: 'Prepare drafts and pictures', description: 'Write drafts of posts, comments and replies and make a picture for a post, saved on this PC. Nothing is published.', risk: 'write' },
    { id: 'posts.publish', label: 'Publish posts', description: 'Fill the post box and press Post — only for the exact text you said yes to, a few a day at most, never at night.', risk: 'send' },
    { id: 'comments.publish', label: 'Publish comments and replies', description: 'Fill a comment or reply box and press Comment / Reply — only for the exact text you said yes to, within daily limits.', risk: 'send' },
  ],
  actions: [
    {
      id: 'prepare_drafts',
      label: 'Write drafts and make pictures',
      description: 'Drafts of a post (first line, text, hashtags), a comment or a reply; a picture card for a post; what you told Eya about yourself, so a post says nothing untrue. Checks the text: no client matter, no promise of a result.',
      tools: ['social_draft', 'social_compose', 'social_make_image', 'social_attach_image', 'social_profile'],
      gate: 'registry',
      permission: 'drafts.write',
      verify: 'The saved draft is read back to you with every problem the checks found. Nothing is sent anywhere.',
    },
    {
      id: 'publish_post',
      label: 'Publish a post',
      description: 'Fill the post box with the exact text and press Post.',
      tools: ['fill_on_page', 'click_on_page'],
      gate: 'send_gate',
      permission: 'posts.publish',
      consequential: true,
      verify: 'The click is held until the checks pass and you say yes to that exact text; it is then written to the ledger (a fingerprint, never the text). Read the page afterwards to see the post.',
    },
    {
      id: 'publish_comment',
      label: 'Comment on someone else\'s post',
      description: 'Fill the comment box with the exact text and press Comment.',
      tools: ['fill_on_page', 'click_on_page'],
      gate: 'send_gate',
      permission: 'comments.publish',
      consequential: true,
      verify: 'Held until the checks pass and you say yes to that exact text; limits: a few a day, a few minutes apart.',
    },
    {
      id: 'publish_reply',
      label: 'Reply to a comment on your post',
      description: 'Fill the reply box under a comment with the exact text and press Reply.',
      tools: ['fill_on_page', 'click_on_page'],
      gate: 'send_gate',
      permission: 'comments.publish',
      consequential: true,
      verify: 'Held until the checks pass and you say yes to that exact text; limits: a few a day, a few minutes apart.',
    },
    {
      id: 'publish_without_asking',
      label: 'Publish without asking you first',
      description: 'Posting or replying by itself with no yes from you.',
      tools: [],
      gate: 'registry',
      verify: 'Not applicable.',
      unsupported: 'Not built, on purpose: everything goes out in your name, and a site restricts an account that publishes by itself. Eya prepares and fills everything; you say yes.',
    },
    {
      id: 'apply_to_jobs',
      label: 'Apply to jobs',
      description: 'Easy Apply and job applications.',
      tools: [],
      gate: 'registry',
      verify: 'Not applicable.',
      unsupported: 'Not built yet (next step after posts and comments).',
    },
  ],
};
