# Third party notices

The host bundle includes fflate, Copyright (c) 2020 Arjun Barrett, licensed under the MIT License. Its license is reproduced below.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

The bundle also includes the stateless `@deepseek-ai/dsh-home-paths` and `@deepseek-ai/dsh-atomic-write` utilities, and the `projectKey` locator function from DeepSeek Harness v0.2.0-rc.2 (`packages/session/session-persistence-jsonl/src/format.ts`), Copyright (c) 2026 DeepSeek, under the same MIT license reproduced above. The locator function is used to validate the exact native session path during deletion.

React and the DeepSeek Harness Session/Cordis runtime modules are resolved from the host application rather than bundled into the distributable. Their respective licenses remain applicable.
