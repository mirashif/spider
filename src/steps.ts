import type { Locator, Page } from 'playwright';
import type { LocatorSpec, Step } from './config.ts';

export function locate(page: Page, spec: LocatorSpec): Locator {
    if ('role' in spec) {
        return page.getByRole(spec.role as Parameters<Page['getByRole']>[0], { name: spec.name, exact: spec.exact });
    }
    if ('testId' in spec) return page.getByTestId(spec.testId);
    if ('text' in spec) return page.getByText(spec.text);
    return page.locator(spec.css);
}

export async function runSteps(page: Page, steps: Step[]): Promise<void> {
    for (const step of steps) {
        if ('goto' in step) await page.goto(step.goto, { waitUntil: 'networkidle' });
        else if ('fill' in step) await locate(page, step.fill).first().fill(step.value);
        else if ('click' in step) await locate(page, step.click).first().click();
        else if ('press' in step) await page.keyboard.press(step.press);
        else if ('waitForURL' in step) await page.waitForURL(step.waitForURL);
        else if ('waitFor' in step) await locate(page, step.waitFor).first().waitFor();
    }
}

export function describeStep(step: Step): string {
    return JSON.stringify(step, (_, value: unknown) => (value instanceof RegExp ? value.toString() : value));
}
