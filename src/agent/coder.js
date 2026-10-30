import { writeFile, readFile, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeCompartment, lockdown } from './library/lockdown.js';
import * as skills from './library/skills.js';
import { judgeRun, saveLearned, inventorySnapshot, inventoryDelta } from './learned_skills.js';
import * as world from './library/world.js';
import { Vec3 } from 'vec3';
import {ESLint} from "eslint";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class Coder {
    constructor(agent) {
        this.agent = agent;
        this.file_counter = 0;
        this.fp = '/bots/'+agent.name+'/action-code/';
        this.code_template = '';
        this.code_lint_template = '';

        readFile(path.join(__dirname, '../../bots/execTemplate.js'), 'utf8', (err, data) => {
            if (err) throw err;
            this.code_template = data;
        });
        readFile(path.join(__dirname, '../../bots/lintTemplate.js'), 'utf8', (err, data) => {
            if (err) throw err;
            this.code_lint_template = data;
        });
        mkdirSync('.' + this.fp, { recursive: true });
    }

    async generateCode(agent_history, goal = null) {
        this.agent.bot.modes.pause('unstuck');
        lockdown();
        // this message history is transient and only maintained in this function
        let messages = agent_history.getHistory(); 
        messages.push({role: 'system', content: 'Code generation started. Write code in codeblock in your response:'});

        const MAX_ATTEMPTS = 5;
        const MAX_NO_CODE = 3;

        let code = null;
        let no_code_failures = 0;
        for (let i=0; i<MAX_ATTEMPTS; i++) {
            if (this.agent.bot.interrupt_code)
                return null;
            const messages_copy = JSON.parse(JSON.stringify(messages));
            let res = await this.agent.prompter.promptCoding(messages_copy);
            if (this.agent.bot.interrupt_code)
                return null;
            let contains_code = res.indexOf('```') !== -1;
            if (!contains_code) {
                if (res.indexOf('!newAction') !== -1) {
                    messages.push({
                        role: 'assistant', 
                        content: res.substring(0, res.indexOf('!newAction'))
                    });
                    continue; // using newaction will continue the loop
                }
                
                if (no_code_failures >= MAX_NO_CODE) {
                    console.warn("Action failed, agent would not write code.");
                    return 'Action failed, agent would not write code.';
                }
                messages.push({
                    role: 'system', 
                    content: 'Error: no code provided. Write code in codeblock in your response. ``` // example ```'}
                );
                console.warn("No code block generated. Trying again.");
                no_code_failures++;
                continue;
            }
            // dafeiyu 2026-10-26: a reply cut off after the opening fence has ONE ``` - upstream then 'extracted' the fence itself and the
            // stage failed with 'Unexpected end of input' (twice tonight). Take everything after a lone fence; an empty block is no code.
            // Only the FIRST block: with two blocks in one reply, first-to-last fence took the prose between them and the second
            // block's "```js" as code ("Unexpected identifier 'js'", 3-day run 10-26).
            const first = res.indexOf('```'), close = res.indexOf('```', first + 3);
            code = close > first ? res.substring(first + 3, close) : res.substring(first + 3);
            if (!code.replace(/^[a-z]*\s*/i, '').trim()) {
                messages.push({ role: 'system', content: 'Error: the code block was empty or cut off. Write the whole code in one complete ``` block.' });
                no_code_failures++;
                if (no_code_failures >= MAX_NO_CODE) return 'Action failed, agent would not write code.';
                continue;
            }
            const result = await this._stageCode(code);
            const executionModule = result.func;
            const lintResult = await this._lintCode(result.src_lint_copy);
            if (lintResult) {
                const message = 'Error: Code lint error:'+'\n'+lintResult+'\nPlease try again.';
                console.warn("Linting error:"+'\n'+lintResult+'\n');
                messages.push({ role: 'system', content: message });
                continue;
            }
            if (!executionModule) {
                console.warn("Failed to stage code, something is wrong.");
                return 'Failed to stage code, something is wrong.';
            }

            try {
                console.log('Executing code...');
                const inventory_before = inventorySnapshot(this.agent.bot);
                await executionModule.main(this.agent.bot);

                const full_output = String(this.agent.bot.output || '');   // the judge reads all of it; she gets the usual summary
                const code_output = this.agent.actions.getBotOutputSummary();
                const summary = "Agent wrote this code: \n```" + this._sanitizeCode(code) + "```\nCode Output:\n" + code_output;
                // dafeiyu (PLAN H): a run a second look judges a real success becomes a skill she can reuse; a failure is never kept.
                let learned_note = '';
                if (goal) {
                    const verdict = await judgeRun(this.agent.prompter, { goal, output: full_output, delta: inventoryDelta(inventory_before, inventorySnapshot(this.agent.bot)) });
                    if (verdict?.success) {
                        const kept = saveLearned(this.agent.name, { skill: verdict.skill, description: verdict.description, goal, code: this._sanitizeCode(code), evidence: verdict.reason, world: this.agent.memoryS?.worldStatus?.()?.key || null,
                            at: (({ x, y, z }) => ({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }))(this.agent.bot.entity.position) });
                        if (kept) learned_note = `\n(Learned a skill: "${kept.name}" - ${kept.description}. Next time you can run it with !useSkill("${kept.name}").)`;
                    } else if (verdict) learned_note = `\n(Checked: the goal was not reached - ${verdict.reason}. Not kept as a skill.)`;
                }
                return summary + learned_note;
            } catch (e) {
                if (this.agent.bot.interrupt_code)
                    return null;
                
                console.warn('Generated code threw error: ' + e.toString());
                console.warn('trying again...');

                const code_output = this.agent.actions.getBotOutputSummary();

                messages.push({
                    role: 'assistant',
                    content: res
                });
                messages.push({
                    role: 'system',
                    content: `Code Output:\n${code_output}\nCODE EXECUTION THREW ERROR: ${e.toString()}\n Please try again:`
                });
            }
        }
        return `Code generation failed after ${MAX_ATTEMPTS} attempts.`;
    }
    
    async  _lintCode(code) {
        let result = '#### CODE ERROR INFO ###\n';
        const codeNoComments = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const skillRegex = /((?:skills|world)\.(.*?))\(/g;
        const skills = [];
        let match;
        while ((match = skillRegex.exec(codeNoComments)) !== null) {
            skills.push(match[1]);
        }
        const allDocs = await this.agent.prompter.skill_libary.getAllSkillDocs();
        const knownSkills = new Set(allDocs.map(doc => doc.split('\n')[0]));
        const missingSkills = skills.filter(skill => !knownSkills.has(skill));
        if (missingSkills.length > 0) {
            result += 'These functions do not exist:\n';
            result += missingSkills.join('\n');
            console.log(result)
            return result;
        }

        const eslint = new ESLint();
        const results = await eslint.lintText(code);
        const codeLines = code.split('\n');
        const exceptions = results.map(r => r.messages).flat();

        if (exceptions.length > 0) {
            exceptions.forEach((exc, index) => {
                if (exc.line && exc.column ) {
                    const errorLine = codeLines[exc.line - 1]?.trim() || 'Unable to retrieve error line content';
                    result += `#ERROR ${index + 1}\n`;
                    result += `Message: ${exc.message}\n`;
                    result += `Location: Line ${exc.line}, Column ${exc.column}\n`;
                    result += `Related Code Line: ${errorLine}\n`;
                }
            });
            result += 'The code contains exceptions and cannot continue execution.';
        } else {
            return null;//no error
        }

        return result ;
    }
    // write custom code to file and import it
    // write custom code to file and prepare for evaluation
    async _stageCode(code, coordinateContext = null) {
        code = this._sanitizeCode(code);
        let src = '';
        code = code.replaceAll('console.log(', 'log(bot,');
        // dafeiyu 2026-10-26: upstream only fixed log("..."); she also writes log(`...`), log('...') and log(JSON.stringify(x)), which then
        // failed three times in a row with "Cannot create property 'output' on string". Add the missing bot to any bare or skills. log call
        // (Math.log, console.log and calls that already pass bot are left alone).
        code = code.replace(/(^|[^\w$.])log\((?!\s*bot\s*[,)])/gm, '$1log(bot, ').replace(/\bskills\.log\((?!\s*bot\s*[,)])/g, 'skills.log(bot, ');
        // 2026-10-27 04:3x: her code reported its result with bot.chat ("place false now=air ...") and she got back only "Code finished" -
        // "没回话，估计又卡住了". What her code says in chat comes back to her in the action's output.
        // GPT #3826 (C12b): six lines like "(51,96,8)=>y-1:dirt/y-2:air" went to public chat from her code - debug output, not talk. Her
        // code's chat now goes only to her output; she talks to players in her own replies (cleaned and voiced like every other line).
        code = code.replace(/\bbot\.chat\(/g, '((m) => { log(bot, `[你的代码想在聊天里说，没有发出去，只给你看] ${m}`); })(');

        console.log(`Generated code: """${code}"""`);

        // this may cause problems in callback functions
        code = code.replaceAll(';\n', '; if(bot.interrupt_code) {log(bot, "Code interrupted.");return;}\n');
        for (let line of code.split('\n')) {
            src += `    ${line}\n`;
        }
        let src_lint_copy = this.code_lint_template.replace('/* CODE HERE */', src);
        src = this.code_template.replace('/* CODE HERE */', src);

        let filename = this.file_counter + '.js';
        // if (this.file_counter > 0) {
        //     let prev_filename = this.fp + (this.file_counter-1) + '.js';
        //     unlink(prev_filename, (err) => {
        //         console.log("deleted file " + prev_filename);
        //         if (err) console.error(err);
        //     });
        // } commented for now, useful to keep files for debugging
        this.file_counter++;
        
        let write_result = await this._writeFilePromise('.' + this.fp + filename, src);
        // This is where we determine the environment the agent's code should be exposed to.
        // It will only have access to these things, (in addition to basic javascript objects like Array, Object, etc.)
        // Note that the code may be able to modify the exposed objects.
        const compartment = makeCompartment({
            skills: coordinateContext?.skills || skills,
            log: coordinateContext?.skills?.log || skills.log,
            world: coordinateContext?.world || world,
            Vec3,
        });
        const mainFn = compartment.evaluate(src);
        
        if (write_result) {
            console.error('Error writing code execution file: ' + write_result);
            return null;
        }
        return { func:{main: mainFn}, src_lint_copy: src_lint_copy };
    }

    _sanitizeCode(code) {
        code = code.trim();
        const remove_strs = ['Javascript', 'javascript', 'js']
        for (let r of remove_strs) {
            if (code.startsWith(r)) {
                code = code.slice(r.length);
                return code;
            }
        }
        return code;
    }

    _writeFilePromise(filename, src) {
        // makes it so we can await this function
        return new Promise((resolve, reject) => {
            writeFile(filename, src, (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }
}
