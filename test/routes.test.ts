import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toRegExp } from '../src/patterns.ts';
import { compilePatterns, inferPatterns, routeFor } from '../src/routes.ts';

test('globs', () => {
    assert.ok(toRegExp('/admin/**').test('/admin'));
    assert.ok(toRegExp('/admin/**').test('/admin/a/b'));
    assert.ok(!toRegExp('/admin/**').test('/adminx'));
    assert.ok(toRegExp('/users/*').test('/users/12'));
    assert.ok(!toRegExp('/users/*').test('/users/12/edit'));
    assert.ok(toRegExp('re:^/admin(?!/login)').test('/admin/users'));
});

test('URLs fold into route patterns', () => {
    const patterns = compilePatterns(['/projects/create', '/projects/:project']);
    assert.equal(routeFor('/projects/create', patterns), '/projects/create');
    assert.equal(routeFor('/projects/alpha/', patterns), '/projects/:project');
    assert.equal(routeFor('/orders/12345', patterns), '/orders/:id');
});

test('patterns guessed from links stay conservative', () => {
    assert.deepEqual(inferPatterns(['/', '/login', '/about', '/author/Jane-Austen', '/author/Steve-Martin', '/author/Albert-Einstein']), ['/', '/about', '/author/:author', '/login']);
    assert.deepEqual(inferPatterns(['/settings/profile', '/settings/billing', '/settings/team']), ['/settings/billing', '/settings/profile', '/settings/team']);
});
