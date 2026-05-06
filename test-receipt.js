/**
 * test-receipt.js
 * Run: node test-receipt.js
 * Prints a sample receipt to stdout (strips ESC/POS control bytes for readability).
 */

import { buildReceipt } from './src/printer.js';

const sampleOrder = {
  id: 123,
  orderNumber: '#42',
  orderType: 'DineIn',
  tableNumber: '5',
  customerName: 'Ahmed Khan',
  subtotal: 400,
  tax: 60,
  discount: 0,
  grandTotal: 460,
  items: [
    {
      name: 'Burger',
      quantity: 2,
      totalPrice: 200,
      variants: [{ selectedOptions: [{ optionName: 'Large' }] }],
      addons: [],
      instructions: 'No onions',
    },
    {
      name: 'Fries',
      quantity: 1,
      totalPrice: 100,
      variants: [],
      addons: [],
    },
    {
      name: 'Pepsi',
      quantity: 1,
      totalPrice: 100,
      variants: [],
      addons: [],
    },
  ],
};

const receipt = buildReceipt(sampleOrder, {
  restaurantName: 'MY RESTAURANT',
  width: 32,
});

// Strip control bytes for terminal display
const readable = receipt.replace(/[\x00-\x1F\x7F]/g, (c) => {
  const hex = c.charCodeAt(0).toString(16).padStart(2, '0');
  return `[${hex}]`;
});

console.log('── Raw receipt (control bytes shown as [hex]) ──');
console.log(readable);
console.log('\n── Printable text only ──');
console.log(receipt.replace(/[^\x20-\x7E\n]/g, ''));
