// Path patterns used in config, the CLI and the UI: globs by default, regexes with a "re:" prefix.
//   /admin/**        /admin and everything below it
//   /admin/*/edit    one segment in the middle
//   re:^/admin(?!/login)  a regex, for the rare case globs can't say it

export type PatternInput = string | RegExp;

export function toRegExp(pattern: PatternInput): RegExp {
    if (pattern instanceof RegExp) return pattern;
    if (pattern.startsWith('re:')) return new RegExp(pattern.slice(3));
    let source = '';
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '*' && pattern[i + 1] === '*') {
            // A trailing "/**" also matches the bare prefix: /admin/** matches /admin.
            if (source.endsWith('/') && i + 2 === pattern.length) {
                source = `${source.slice(0, -1)}(?:/.*)?`;
            } else {
                source += '.*';
            }
            i++;
        } else if (c === '*') source += '[^/]*';
        else if (c === '?') source += '[^/]';
        else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${source}$`);
}

export function matchesAny(path: string, patterns: RegExp[] | undefined): boolean {
    return Boolean(patterns?.some((re) => re.test(path)));
}

/** Strings in config can be regexes too ("re:…"); everything else stays a string (globs for URLs, plain text for names). */
export function maybeRegExp(value: string): string | RegExp {
    return value.startsWith('re:') ? new RegExp(value.slice(3)) : value;
}
