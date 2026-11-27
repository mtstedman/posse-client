import { EXPERIMENT_CANDIDATE_CHECK_LIMITS as L } from '../../../catalog/experiment-candidate-checks.js';
import { experimentDigest } from './snapshots.js';

export function validateCandidateChecks(setup) {
  const checks = setup.candidate_checks || [];
  const paths = new Set(setup.plan.files.map(file => file.path));
  if (checks.length && [`${L.entrypoint}.mjs`, `${L.entrypoint}.py`].some(name => paths.has(name))) throw Error('Candidate-check entrypoint is reserved.');
  if (checks.reduce((sum, check) => sum + check.timeout_seconds, 0) > L.totalSeconds) throw Error('Candidate checks exceed their total timeout allowance.');
  for (const check of checks) {
    if (!/^work(?:\/[a-zA-Z0-9_.-]+)*$/.test(check.cwd) || check.cwd.split('/').some(part => part === '.' || part === '..')) throw Error('Candidate checks must run inside the payload work directory.');
    if ([check.program, ...check.args].some(value => value.includes('\0'))) throw Error('Invalid candidate-check command.');
    if (check.when_nonempty.some(name => !paths.has(name))) throw Error('Candidate-check conditions must reference declared payload files.');
  }
}

// No corpus inputs or answer keys are mounted for checks. This owner-generated
// wrapper captures child output; only its exit status becomes a numeric result.
export function candidateCheckPayload(setup, files, check) {
  const node = setup.plan.runtime.profile === 'node';
  const entrypoint = `${L.entrypoint}.${node ? 'mjs' : 'py'}`;
  const config = JSON.stringify(check); // Relative to the sandbox's fixed /payload working directory.
  const source = node ? `import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const request=JSON.parse(fs.readFileSync(0,'utf8').trim());
const check=${config};
const result=spawnSync(check.program,check.args,{cwd:check.cwd,timeout:check.timeout_seconds*1000,killSignal:'SIGKILL',encoding:'utf8',maxBuffer:49152,env:{...process.env,CI:'1',NO_COLOR:'1',TMPDIR:'/tmp'}});
const log=String(result.stdout||'')+String(result.stderr||'')+(result.error?'\\n'+result.error.message:'');
process.stderr.write(log.slice(-12000));
process.stdout.write(JSON.stringify({case_id:request.case_id,prediction:result.status===0&&!result.error?1:0})+'\\n');
` : `import json,os,subprocess,sys,tempfile
request=json.loads(sys.stdin.read())
check=json.loads(${JSON.stringify(config)})
ok=False
with tempfile.TemporaryFile() as output:
    try:
        result=subprocess.run([check['program'],*check['args']],cwd=check['cwd'],stdin=subprocess.DEVNULL,stdout=output,stderr=subprocess.STDOUT,timeout=check['timeout_seconds'],env={**os.environ,'CI':'1','NO_COLOR':'1','TMPDIR':'/tmp'})
        ok=result.returncode==0 and output.tell()<=49152
    except Exception as error:
        sys.stderr.write(str(error)+'\\n')
    output.seek(max(0,output.tell()-12000))
    sys.stderr.write(output.read(12000).decode('utf8',errors='replace'))
sys.stdout.write(json.dumps({'case_id':request['case_id'],'prediction':1 if ok else 0})+'\\n')
`;
  const evaluation = { schema: 'posse.experiment.numeric.v1', cases: [{ id: 'candidate-check', input: {}, expected: 1 }], scorers: { passed: 'exact_match' } };
  const plan = { ...setup.plan, entrypoint,
    evaluation: { ...setup.plan.evaluation, digest: experimentDigest(evaluation) },
    metrics: [{ id: 'passed', role: 'goal', unit: 'score', direction: 'higher', aggregation: 'mean', target: 1 }],
    acceptance: { mode: 'automatic', primary_metric: 'passed', min_improvement: 0 },
    resources: { ...setup.plan.resources, wall_seconds: Math.min(L.totalSeconds, check.timeout_seconds + 10), max_output_bytes: L.outputBytes } };
  return { plan, evaluation, files: { ...files, [entrypoint]: source } };
}

export function selectedCandidateChecks(setup, accepted, candidate) {
  return (setup.candidate_checks || []).map((check, index) => ({ check, index }))
    .filter(({ check }) => !check.when_nonempty.length || check.when_nonempty.some(name => candidate[name]?.trim() || accepted[name]?.trim()));
}
