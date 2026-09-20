import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NotificationCapsule } from "../src/NotificationCapsule";
import type { UiNotification } from "../src/notificationModel";
afterEach(cleanup);
const event: UiNotification={id:'rain',type:'rain',category:'weather',severity:'alert',title:'Heavy rain',summary:'Rain over the district',timestamp:60,startedAt:60,newsIds:[1],details:[],technical:[],count:1};
it('preempts an expanded event with a system error, and removes it on recovery',()=>{
  const props={items:[event],focusedKey:null,reduceMotion:true,onDismiss:vi.fn()};
  const {rerender}=render(<NotificationCapsule {...props}/>);
  fireEvent.click(screen.getByRole('button',{name:/Expand notification/}));
  rerender(<NotificationCapsule {...props} systemError="Simulator unavailable"/>);
  expect(screen.getByRole('alert')).toHaveTextContent('Simulator unavailable');
  expect(screen.getByRole('button',{name:/Collapse notification/})).toHaveTextContent('System error');
  rerender(<NotificationCapsule {...props}/>);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button',{name:/Collapse notification/})).toHaveTextContent('Heavy rain');
});
it('shows runtime failures even when DND leaves no visible events',()=>{
  render(<NotificationCapsule items={[]} focusedKey={null} reduceMotion onDismiss={vi.fn()} systemError="Connection failed"/>);
  expect(screen.getByRole('alert')).toHaveTextContent('Connection failed');
  expect(screen.queryByLabelText('Dismiss notification')).toBeNull();
});
it('retains a stable notification anchor when no event is present',()=>{
  const {container}=render(<NotificationCapsule items={[]} focusedKey={null} reduceMotion onDismiss={vi.fn()}/>);
  expect(container.querySelector('[data-tutorial="notifications"]')).toBeInTheDocument();
  expect(screen.getByText('No new events')).toBeInTheDocument();
});
it('keeps a lone system error expanded until recovery',()=>{
  const props={items:[],focusedKey:null,reduceMotion:true,onDismiss:vi.fn()};
  const {rerender}=render(<NotificationCapsule {...props} systemError="Connection failed"/>);
  fireEvent.click(screen.getByRole('button',{name:/Expand notification/}));
  expect(screen.getByRole('button',{name:/Collapse notification/})).toBeInTheDocument();
  rerender(<NotificationCapsule {...props}/>);
  expect(screen.queryByRole('alert')).toBeNull();
});
