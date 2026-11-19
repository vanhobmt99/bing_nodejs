import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const require = createRequire(import.meta.url)

const { canPromptForInput, isInteractiveStdinEnv, promptInput } = require('../dist/browser/auth/methods/LoginUtils.js')
const { executionContext } = require('../dist/core/ExecutionContext.js')

function runNodeScript(script, { stdio = ['pipe', 'pipe', 'pipe'], env = {} } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script], {
            cwd: repoRoot,
            stdio,
            env: { ...process.env, ...env }
        })
        let stdout = ''
        let stderr = ''
        child.stdout?.on('data', chunk => {
            stdout += chunk.toString('utf8')
        })
        child.stderr?.on('data', chunk => {
            stderr += chunk.toString('utf8')
        })
        child.once('error', reject)
        child.once('close', code => resolve({ code, stdout, stderr }))
        return child
    })
}

test('isInteractiveStdinEnv and canPromptForInput detect TTY, pipes, and /dev/null accurately', async () => {
    assert.equal(isInteractiveStdinEnv({ INTERACTIVE_STDIN: 'true' }), true)
    assert.equal(isInteractiveStdinEnv({ INTERACTIVE_STDIN: '1' }), true)
    assert.equal(isInteractiveStdinEnv({ INTERACTIVE_STDIN: 'false' }), false)
    assert.equal(isInteractiveStdinEnv({}), false)

    const stream = new PassThrough()
    assert.equal(canPromptForInput({ input: stream, env: { INTERACTIVE_STDIN: 'false' } }), false)
    assert.equal(canPromptForInput({ input: stream, env: { INTERACTIVE_STDIN: 'true' } }), true)
    stream.end()
    stream.resume()
    await new Promise(resolve => stream.once('end', resolve))
    assert.equal(canPromptForInput({ input: stream, env: { INTERACTIVE_STDIN: 'true' } }), false)

    const probe = `const { canPromptForInput } = require('./dist/browser/auth/methods/LoginUtils.js'); console.log(canPromptForInput())`

    const withPipeEnabled = await runNodeScript(probe, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { INTERACTIVE_STDIN: 'true', INTERACTIVE_STDIN_RELAY: '' }
    })
    assert.equal(withPipeEnabled.code, 0, withPipeEnabled.stderr)
    assert.equal(withPipeEnabled.stdout.trim(), 'true')

    const withPipeDisabled = await runNodeScript(probe, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { INTERACTIVE_STDIN: 'false', INTERACTIVE_STDIN_RELAY: '' }
    })
    assert.equal(withPipeDisabled.code, 0, withPipeDisabled.stderr)
    assert.equal(withPipeDisabled.stdout.trim(), 'false')

    const withIgnoredStdin = await runNodeScript(probe, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { INTERACTIVE_STDIN: 'true', INTERACTIVE_STDIN_RELAY: '' }
    })
    assert.equal(withIgnoredStdin.code, 0, withIgnoredStdin.stderr)
    assert.equal(withIgnoredStdin.stdout.trim(), 'false')
})

test('promptInput handles sequential non-TTY pipe prompts, validation, context prefix, and CRLF', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let written = ''
    output.on('data', chunk => {
        written += chunk.toString('utf8')
    })

    const io = { input, output, env: { INTERACTIVE_STDIN: 'true' } }
    const account = { email: 'user@example.test' }

    const result = await executionContext.run({ isMobile: true, account }, async () => {
        const emailPromise = promptInput(
            {
                question: 'Enter email: ',
                timeoutSeconds: 5,
                validate: value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
            },
            io
        )
        input.write('  user@example.test  \r\n')
        const email = await emailPromise

        const badCodePromise = promptInput(
            {
                question: 'Enter code: ',
                timeoutSeconds: 5,
                validate: value => /^\d{6}$/.test(value)
            },
            io
        )
        input.write('123\n')
        const badCode = await badCodePromise

        const goodCodePromise = promptInput(
            {
                question: 'Enter code: ',
                timeoutSeconds: 5,
                validate: value => /^\d{6}$/.test(value)
            },
            io
        )
        input.write('654321\n')
        const goodCode = await goodCodePromise

        return { email, badCode, goodCode }
    })

    assert.deepEqual(result, { email: 'user@example.test', badCode: null, goodCode: '654321' })
    assert.match(written, /\[user@example\.test \| MOBILE\] Enter email: \n/)
    assert.match(written, /\[user@example\.test \| MOBILE\] Enter code: \n/)
})

test('promptInput serializes concurrent prompts and aborts or ends cleanly on EOF', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const prompts = []
    output.on('data', chunk => {
        prompts.push(chunk.toString('utf8'))
    })
    const io = { input, output, env: { INTERACTIVE_STDIN: 'true' } }

    const first = promptInput({ question: 'Prompt 1: ', timeoutSeconds: 5 }, io)
    const second = promptInput({ question: 'Prompt 2: ', timeoutSeconds: 5 }, io)

    await new Promise(resolve => setImmediate(resolve))
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0], 'Prompt 1: \n')

    input.write('alpha\n')
    assert.equal(await first, 'alpha')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(prompts.length, 2)
    assert.equal(prompts[1], 'Prompt 2: \n')

    input.write('beta\n')
    assert.equal(await second, 'beta')

    // AbortSignal resolves immediately without waiting for timeout.
    const controller = new AbortController()
    const started = Date.now()
    const abortedPrompt = promptInput({ question: 'Abort me: ', timeoutSeconds: 30, signal: controller.signal }, io)
    setTimeout(() => controller.abort(), 20)
    assert.equal(await abortedPrompt, null)
    assert.ok(Date.now() - started < 2000)

    // EOF returns null immediately without hanging.
    const eofStarted = Date.now()
    const eofPrompt = promptInput({ question: 'EOF test: ', timeoutSeconds: 30 }, io)
    input.end()
    assert.equal(await eofPrompt, null)
    assert.ok(Date.now() - eofStarted < 2000)
})

test('subprocess exits cleanly after pipe promptInput while stdin stays open', async () => {
    const script = `
        const { promptInput } = require('./dist/browser/auth/methods/LoginUtils.js')
        ;(async () => {
            const code = await promptInput({ question: 'OTP:', timeoutSeconds: 5, validate: v => /^\\d{6}$/.test(v) })
            console.log('GOT:' + code)
        })()
    `
    const child = spawn(process.execPath, ['-e', script], {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, INTERACTIVE_STDIN: 'true', INTERACTIVE_STDIN_RELAY: '' }
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
        const text = chunk.toString('utf8')
        stdout += text
        if (text.includes('OTP:')) {
            // Deliberately do NOT close child.stdin to simulate an always-open Docker FIFO.
            child.stdin.write('987654\n')
        }
    })
    child.stderr.on('data', chunk => {
        stderr += chunk.toString('utf8')
    })

    const exitCode = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill('SIGKILL')
            reject(new Error(`Subprocess hung with open stdin | stdout=${stdout} | stderr=${stderr}`))
        }, 5000)
        child.once('close', code => {
            clearTimeout(timer)
            resolve(code)
        })
    })

    assert.equal(exitCode, 0, stderr)
    assert.match(stdout, /GOT:987654/)
})

test('cluster IPC stdin relay serializes prompts across workers over piped stdin', async t => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-stdin-cluster-'))
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }))
    const scriptPath = path.join(tempDir, 'cluster-relay.cjs')
    const loginUtilsPath = path.join(repoRoot, 'dist/browser/auth/methods/LoginUtils.js')
    const execCtxPath = path.join(repoRoot, 'dist/core/ExecutionContext.js')
    fs.writeFileSync(
        scriptPath,
        `
        const cluster = require('node:cluster')
        const {
            canPromptForInput,
            installClusterStdinRelay,
            promptInput,
            teardownClusterStdinRelay
        } = require(${JSON.stringify(loginUtilsPath)})
        const { executionContext } = require(${JSON.stringify(execCtxPath)})

        if (cluster.isPrimary) {
            installClusterStdinRelay()
            const results = {}
            let remaining = 2
            for (const email of ['first@example.test', 'second@example.test']) {
                const worker = cluster.fork({ TEST_EMAIL: email })
                worker.on('message', msg => {
                    if (msg && msg.done) {
                        results[msg.email] = msg.code
                    }
                })
                worker.once('exit', () => {
                    remaining -= 1
                    if (remaining === 0) {
                        teardownClusterStdinRelay()
                        console.log('SUMMARY:' + JSON.stringify(results))
                    }
                })
            }
        } else {
            ;(async () => {
                const email = process.env.TEST_EMAIL
                if (!canPromptForInput()) process.exit(2)
                const code = await executionContext.run({ isMobile: true, account: { email } }, () =>
                    promptInput({ question: 'Code:', timeoutSeconds: 5, validate: v => /^\\d{6}$/.test(v) })
                )
                process.send({ done: true, email, code }, () => process.exit(0))
            })()
        }
    `,
        'utf8'
    )

    const child = spawn(process.execPath, [scriptPath], {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, INTERACTIVE_STDIN: 'true', INTERACTIVE_STDIN_RELAY: '' }
    })

    let stdout = ''
    let stderr = ''
    const answered = new Set()
    child.stdout.on('data', chunk => {
        const text = chunk.toString('utf8')
        stdout += text
        for (const line of stdout.split('\n')) {
            if (line.includes('[first@example.test | MOBILE] Code:') && !answered.has('first')) {
                answered.add('first')
                child.stdin.write('111111\n')
            } else if (line.includes('[second@example.test | MOBILE] Code:') && !answered.has('second')) {
                answered.add('second')
                child.stdin.write('222222\n')
            }
        }
    })
    child.stderr.on('data', chunk => {
        stderr += chunk.toString('utf8')
    })

    const exitCode = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill('SIGKILL')
            reject(new Error(`Cluster relay test hung | stdout=${stdout} | stderr=${stderr}`))
        }, 10000)
        child.once('close', code => {
            clearTimeout(timer)
            resolve(code)
        })
    })

    assert.equal(exitCode, 0, stderr)
    const match = /SUMMARY:(\{.*\})/.exec(stdout)
    assert.ok(match, `Missing SUMMARY in stdout: ${stdout}`)
    assert.deepEqual(JSON.parse(match[1]), {
        'first@example.test': '111111',
        'second@example.test': '222222'
    })
})

test('Docker configuration and shell scripts enable interactive stdin with LF endings', () => {
    const compose = fs.readFileSync(path.join(repoRoot, 'compose.yaml'), 'utf8')
    assert.match(compose, /^\s*stdin_open:\s*true\s*$/m)
    assert.match(compose, /^\s*tty:\s*true\s*$/m)
    assert.match(compose, /^\s*INTERACTIVE_STDIN:\s*'true'\s*$/m)

    const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8')
    assert.match(dockerfile, /COPY --chmod=755 scripts\/docker\/send_input\.sh \.\/scripts\/docker\/send_input\.sh/)

    for (const relPath of [
        'scripts/docker/entrypoint.sh',
        'scripts/docker/run_daily.sh',
        'scripts/docker/send_input.sh'
    ]) {
        const raw = fs.readFileSync(path.join(repoRoot, relPath), 'utf8')
        assert.equal(raw.includes('\r'), false, `${relPath} must use LF line endings for Linux containers`)
    }
})
