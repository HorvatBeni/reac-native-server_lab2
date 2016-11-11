import {
  OK, NOT_FOUND, LAST_MODIFIED, NOT_MODIFIED, BAD_REQUEST, ETAG,
  CONFLICT, METHOD_NOT_ALLOWED, NO_CONTENT, CREATED, FORBIDDEN, setIssueRes
} from './utils';
import Router from 'koa-router';
import {getLogger} from './utils';

const log = getLogger('note');

let notesLastUpdateMillis = null;

export class NoteRouter extends Router {
  constructor(props) {
    super(props);
    this.noteStore = props.noteStore;
    this.io = props.io;
    this.get('/', async(ctx) => {
      let res = ctx.response;
      let lastModified = ctx.request.get(LAST_MODIFIED);
      if (lastModified && notesLastUpdateMillis && notesLastUpdateMillis <= new Date(lastModified).getTime()) {
        log('search / - 304 Not Modified (the client can use the cached data)');
        res.status = NOT_MODIFIED;
      } else {
        res.body = await this.noteStore.find({user: ctx.state.user._id});
        if (!notesLastUpdateMillis) {
          notesLastUpdateMillis = Date.now();
        }
        res.set({[LAST_MODIFIED]: new Date(notesLastUpdateMillis)});
        log('search / - 200 Ok');
      }
    }).get('/:id', async(ctx) => {
      let note = await this.noteStore.findOne({_id: ctx.params.id});
      let res = ctx.response;
      if (note) {
        if (note.user == ctx.state.user._id) {
          log('read /:id - 200 Ok');
          this.setNoteRes(res, OK, note); //200 Ok
        } else {
          log('read /:id - 403 Forbidden');
          setIssueRes(res, FORBIDDEN, [{error: "It's not your note"}]);
        }
      } else {
        log('read /:id - 404 Not Found (if you know the resource was deleted, then you can return 410 Gone)');
        setIssueRes(res, NOT_FOUND, [{warning: 'Note not found'}]);
      }
    }).post('/', async(ctx) => {
      let note = ctx.request.body;
      let res = ctx.response;
      if (note.text) { //validation
        note.user = ctx.state.user._id;
        await this.createNote(ctx, res, note);
      } else {
        log(`create / - 400 Bad Request`);
        setIssueRes(res, BAD_REQUEST, [{error: 'Text is missing'}]);
      }
    }).put('/:id', async(ctx) => {
      let note = ctx.request.body;
      let id = ctx.params.id;
      let noteId = note._id;
      let res = ctx.response;
      if (noteId && noteId != id) {
        log(`update /:id - 400 Bad Request (param id and body _id should be the same)`);
        setIssueRes(res, BAD_REQUEST, [{error: 'Param id and body _id should be the same'}]);
        return;
      }
      if (!note.text) {
        log(`update /:id - 400 Bad Request (validation errors)`);
        setIssueRes(res, BAD_REQUEST, [{error: 'Text is missing'}]);
        return;
      }
      if (!noteId) {
        await this.createNote(ctx, res, note);
      } else {
        let persistedNote = await this.noteStore.findOne({_id: id});
        if (persistedNote) {
          if (persistedNote.user != ctx.state.user._id) {
            log('update /:id - 403 Forbidden');
            setIssueRes(res, FORBIDDEN, [{error: "It's not your note"}]);
            return;
          }
          let noteVersion = parseInt(ctx.request.get(ETAG)) || note.version;
          if (!noteVersion) {
            log(`update /:id - 400 Bad Request (no version specified)`);
            setIssueRes(res, BAD_REQUEST, [{error: 'No version specified'}]); //400 Bad Request
          } else if (noteVersion < persistedNote.version) {
            log(`update /:id - 409 Conflict`);
            setIssueRes(res, CONFLICT, [{error: 'Version conflict'}]); //409 Conflict
          } else {
            note.version = noteVersion + 1;
            note.updated = Date.now();
            let updatedCount = await this.noteStore.update({_id: id}, note);
            notesLastUpdateMillis = note.updated;
            if (updatedCount == 1) {
              this.setNoteRes(res, OK, note); //200 Ok
              this.io.to(ctx.state.user.username).emit('note/updated', note);
            } else {
              log(`update /:id - 405 Method Not Allowed (resource no longer exists)`);
              setIssueRes(res, METHOD_NOT_ALLOWED, [{error: 'Note no longer exists'}]); //
            }
          }
        } else {
          log(`update /:id - 405 Method Not Allowed (resource no longer exists)`);
          setIssueRes(res, METHOD_NOT_ALLOWED, [{error: 'Note no longer exists'}]); //Method Not Allowed
        }
      }
    }).del('/:id', async(ctx) => {
      let id = ctx.params.id;
      await this.noteStore.remove({_id: id, user: ctx.state.user._id});
      this.io.to(ctx.state.user.username).emit('note/deleted', {_id: id})
      notesLastUpdateMillis = Date.now();
      ctx.response.status = NO_CONTENT;
      log(`remove /:id - 204 No content (even if the resource was already deleted), or 200 Ok`);
    });
  }

  async createNote(ctx, res, note) {
    note.version = 1;
    note.updated = Date.now();
    let insertedNote = await this.noteStore.insert(note);
    notesLastUpdateMillis = note.updated;
    this.setNoteRes(res, CREATED, insertedNote); //201 Created
    this.io.to(ctx.state.user.username).emit('note/created', insertedNote);
  }

  setNoteRes(res, status, note) {
    res.body = note;
    res.set({
      [ETAG]: note.version,
      [LAST_MODIFIED]: new Date(note.updated)
    });
    res.status = status; //200 Ok or 201 Created
  }
}
