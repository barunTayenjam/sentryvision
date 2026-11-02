import { test, expect } from '@playwright/test';

test('ask page: login + ask "what happened between 2pm and 3pm yesterday"', async ({ page }) => {
  // Login with real DB credentials
  await page.goto('http://localhost:3000/login');
  await page.fill('input[placeholder="admin"]', 'barun');  // from DB
  await page.fill('input[type="password"]', 'Password123!'); // from test files
  await page.click('button:has-text("Sign in")');
  
  // Wait for redirect to home or ask page
  await page.waitForURL('**/', { timeout: 10000 });
  await page.waitForSelector('[data-test="sidebar-ask"], [href="/ask"]', { timeout: 5000 });
  
  // Go to ask page
  await page.click('[href="/ask"]');
  await page.waitForSelector('textarea[placeholder*="when did"], textarea[placeholder*="Ask"]', { timeout: 5000 });
  
  // Clear any existing content and ask question
  await page.fill('textarea', '');
  await page.fill('textarea', 'what happened between 2pm and 3pm yesterday');
  
  // Click send button (has aria-label="Send" or type="submit")
  await page.click('button[aria-label="Send"], button[type="submit"]');
  
  // Wait for response
  await page.waitForSelector('[data-testid="chat-message"], .chat-message, [role="log"]', { timeout: 15000 });
  
  // Get last message (should be bot response)
  const lastMsg = page.locator('[data-testid="chat-message"], .chat-message, [role="log"]').last();
  const answer = await lastMsg.innerText();
  
  console.log('PLAYWRIGHT E2E RESULT:');
  console.log('======================');
  console.log(answer);
  console.log('======================');
  
  // Basic validation
  expect(answer.length).toBeGreaterThan(10);
  expect(answer).not.toContain('Authentication token is required');
  expect(answer).not.toContain('Error:');
  
  // Should contain time-related info or visit info
  expect(answer.toLowerCase()).toMatch(/(2pm|3pm|between|visit|person|time|hour|arrived|last seen)/);
});
