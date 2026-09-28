/**
 * Whether this build has a dedicated privacy page for candidates.
 *
 * The page is being added by another lane, and the candidate status page needs
 * to link "what is kept about you, and for how long" either way. Resolved at
 * build time rather than guessed: Vite expands the glob over the pages folder,
 * so the moment `pages/Privacy*.tsx` lands the link points at it, and until
 * then it points at the existing notice on the About page. Linking a route
 * React Router does not know would send someone asking a data question to a
 * redirect back to the console — the worst possible answer to it.
 */
const privacyPages = import.meta.glob('../pages/Privacy*.tsx');

export const hasPrivacyPage: boolean = Object.keys(privacyPages).length > 0;
