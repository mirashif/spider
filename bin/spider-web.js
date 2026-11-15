#!/usr/bin/env node
// Runs the TypeScript sources through tsx until the package ships compiled JS.
import { register } from 'tsx/esm/api';

register();
await import('../src/cli.ts');
