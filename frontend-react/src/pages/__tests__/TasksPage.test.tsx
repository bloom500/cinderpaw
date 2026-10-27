import {beforeEach,it,expect,vi} from 'vitest';
import {render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {invoke} from '@tauri-apps/api/core';
import {MemoryRouter} from 'react-router-dom';
import {TasksPage} from '../TasksPage';
import {useTasks} from '@/stores/tasks';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(()=>Promise.resolve())}));
beforeEach(()=>{vi.mocked(invoke).mockClear();useTasks.setState({loaded:true,error:null,jobs:[{id:'j',name:'Check release',task:'Tell me',kind:'watch',watch:{sourceUrl:'https://example.com',contains:'Available'},expiresAt:Date.now()+86400000,spentUsd:0,enabled:true,schedule:{kind:'every',intervalMs:3600000},history:[{runAt:1,status:'waiting',durationMs:1,result:'Not yet'}]}]});});
it('keeps history and runtime details behind disclosures, and preserves editing',async()=>{
 render(<MemoryRouter><TasksPage/></MemoryRouter>);await userEvent.click(screen.getByRole('button',{name:'Check release'}));
 expect(screen.getByText('Waiting for condition')).not.toBeVisible();
 await userEvent.click(screen.getByText('Activity', {exact:true}));
 expect(screen.getByText('Waiting for condition')).toBeVisible();
 expect(screen.getByText('Waiting for condition')).not.toHaveClass('text-error');
 await userEvent.click(screen.getByRole('button',{name:'Edit task'}));
 await userEvent.clear(screen.getByLabelText('Task name'));await userEvent.type(screen.getByLabelText('Task name'),'Launch watch');
 await userEvent.click(screen.getByRole('button',{name:'Save changes'}));
 expect(invoke).toHaveBeenCalledWith('cinderpaw_cron_op',expect.objectContaining({action:'edit',jobId:'j',name:'Launch watch',kind:'watch'}));
 await userEvent.click(screen.getByRole('button',{name:'Task settings'}));
 expect(screen.getByText(/past agent actions/i)).toBeVisible();
});

it('keeps custom cron expressions in the editor instead of the task row',async()=>{
 useTasks.setState(s=>({jobs:s.jobs.map(j=>({...j,schedule:{kind:'cron',expression:'*/5 * * * *'}}))}));
 render(<MemoryRouter><TasksPage/></MemoryRouter>);
 expect(screen.getByText('Custom schedule')).toBeVisible();
 expect(screen.queryByText('*/5 * * * *')).toBeNull();
 await userEvent.click(screen.getByRole('button',{name:'Check release'}));
 await userEvent.click(screen.getByRole('button',{name:'Edit task'}));
 expect(screen.getByLabelText('Schedule value')).toHaveValue('*/5 * * * *');
});

it('does not call a one-time run done while it is still running or has failed', () => {
 useTasks.setState({jobs:[{id:'one',name:'Prepare report',task:'Prepare report',kind:'agent',enabled:true,schedule:{kind:'at',isoTimestamp:'2026-10-24T10:00:00Z'},history:[{runAt:1,status:'running',durationMs:0}]}]});
 const {unmount}=render(<MemoryRouter><TasksPage/></MemoryRouter>);
 expect(screen.getByText('Running')).toBeVisible();
 expect(screen.queryByText('Done')).toBeNull();
 unmount();
 useTasks.setState(s=>({jobs:s.jobs.map(j=>({...j,history:[{runAt:1,status:'failed',durationMs:1}]}))}));
 render(<MemoryRouter><TasksPage/></MemoryRouter>);
 expect(screen.queryByText('Done')).toBeNull();
});

it('distinguishes a completed source watch from a paused one', () => {
 useTasks.setState(s=>({jobs:s.jobs.map(j=>({...j,enabled:false,history:[{runAt:1,status:'success',durationMs:1}]}))}));
 render(<MemoryRouter><TasksPage/></MemoryRouter>);
 expect(screen.getByText('Done')).toBeVisible();
 expect(screen.queryByText('Paused')).toBeNull();
});

it('says where tasks reach you, sends a real test, and points to connecting a phone when none is', async () => {
 useTasks.setState({phone:{via:'telegram',tested:false},testing:false});
 const {unmount}=render(<MemoryRouter><TasksPage/></MemoryRouter>);
 expect(screen.getByText('Tasks also reach you on Telegram.')).toBeVisible();
 await userEvent.click(screen.getByRole('button',{name:'Send a test'}));
 expect(invoke).toHaveBeenCalledWith('cinderpaw_cron_op',expect.objectContaining({action:'test_notify'}));
 expect(screen.getByText('Sending a test…')).toBeVisible();
 unmount();
 useTasks.setState({phone:{via:null,tested:false},testing:false});
 render(<MemoryRouter><TasksPage/></MemoryRouter>);
 expect(screen.getByText('Tasks reach you only here. Get them on your phone too.')).toBeVisible();
 expect(screen.getByRole('button',{name:'Connect your phone'})).toBeVisible();
});
