import {beforeEach,it,expect,vi} from 'vitest';
import {render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {invoke} from '@tauri-apps/api/core';
import {MemoryRouter} from 'react-router-dom';
import {ComposedPages as Pages, PAGE_IDEAS} from '../ComposedPages';
import {useOnboarding} from '@/stores/onboarding';
const ComposedPages=()=> <MemoryRouter><Pages/></MemoryRouter>;
import {useTasks} from '@/stores/tasks';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(()=>Promise.resolve())}));
const now=Date.now(), D=86400000;
beforeEach(()=>{vi.mocked(invoke).mockClear();useTasks.setState({pages:[
 {id:'p1',title:'My thesis',recipe:'{}',cards:[
  {piece:'countdown',label:'Hand-in',at:now+10*D+60000},
  {piece:'plain_list',label:'Papers to read',items:['Smith 2024','Ionescu 2025']},
  {piece:'number_over_time',label:'Average grade',prices:[{at:now-D,amount:8.7},{at:now,amount:9.1}],limit:9.5},
  {piece:'before_after',label:'Flour, 25 kg',before:130,after:118,unit:'EUR'},
  {piece:'done_with_proof',label:'Nightly build',runs:[{at:now,ok:false,text:'Build broke on main'}]},
  {piece:'your_numbers',label:'This week',wroteFirst:5,answered:3,days:[0,1,0,2,1,0,1]},
  {piece:'gone',label:'Bins'},
 ]}]} as never);});
it('draws every piece from its data, in plain words', () => {
 render(<ComposedPages/>);
 expect(screen.getByRole('heading',{name:'My thesis'})).toBeInTheDocument();
 expect(screen.getByText('11 days')).toBeInTheDocument();
 expect(screen.getByText('Ionescu 2025')).toBeInTheDocument();
 expect(screen.getByRole('img',{name:'Price over 7 days: from 8.7 to 9.1. Your limit is 9.5.'})).toBeInTheDocument();
 expect(screen.getByText('118 EUR')).toBeInTheDocument();
 expect(screen.getByText('Build broke on main')).toBeInTheDocument();
 expect(screen.getByLabelText('Did not work')).toBeInTheDocument();
 expect(screen.getByText('times I wrote first · 3 you used',{exact:false})).toBeInTheDocument();
 expect(screen.getByText('The task or watch behind this card was deleted.')).toBeInTheDocument();
});
it('remove asks once, then tells the engine which page', async () => {
 render(<ComposedPages/>);
 await userEvent.click(screen.getByRole('button',{name:'Remove My thesis'}));
 await userEvent.click(screen.getByRole('button',{name:'Remove page'}));
 expect(invoke).toHaveBeenCalledWith('cinderpaw_cron_op',expect.objectContaining({action:'page_remove',jobId:'p1'}));
});
it('with no page yet, plain ideas; a tap puts the words in the chat box, not sent', async () => {
 useTasks.setState({pages:[]});
 render(<ComposedPages/>);
 expect(screen.getByRole('heading',{name:'Make a page of your own'})).toBeInTheDocument();
 await userEvent.click(screen.getByRole('button',{name:PAGE_IDEAS[1]}));
 expect(useOnboarding.getState().firstTask).toBe(PAGE_IDEAS[1]);
 expect(invoke).not.toHaveBeenCalled();
});
it('a question card: Yes tells the engine which card; an answered one says what you said', async () => {
 useTasks.setState({pages:[{id:'p2',title:'Shop',recipe:'{}',cards:[{piece:'plain_list',label:'Today',items:['Bread']},{piece:'question',label:'Supplier',ask:'Should I ask Moara Noua for a price?'}]},
  {id:'p3',title:'Old',recipe:'{}',cards:[{piece:'question',label:'Q',ask:'Buy?',answer:'not_now'}]}]} as never);
 render(<ComposedPages/>);
 await userEvent.click(screen.getByRole('button',{name:'Yes'}));
 expect(invoke).toHaveBeenCalledWith('cinderpaw_cron_op',expect.objectContaining({action:'page_answer',jobId:'p2:1',enabled:true}));
 expect(screen.getByText('You said not now.')).toBeInTheDocument();
});
it('copy recipe puts the blanked page on the clipboard', async () => {
 const writeText=vi.fn(()=>Promise.resolve());
 Object.defineProperty(navigator,'clipboard',{value:{writeText},configurable:true});
 useTasks.setState({pages:[{id:'p4',title:'Shop',recipe:'{"recipe":"cinderpaw-page/1"}',cards:[{piece:'plain_list',label:'Today',items:['Bread']}]}]} as never);
 render(<ComposedPages/>);
 await userEvent.click(screen.getByRole('button',{name:'Copy recipe'}));
 expect(writeText).toHaveBeenCalledWith('{"recipe":"cinderpaw-page/1"}');
 expect(await screen.findByText('Copied')).toBeInTheDocument();
});
