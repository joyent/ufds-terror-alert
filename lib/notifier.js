/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright 2021 Joyent, Inc.
 */

module.exports = Notifier;

var mod_assert = require('assert-plus');
var mod_bunyan = require('bunyan');
var mod_sshpk = require('sshpk');
var mod_vasync = require('vasync');
var mod_path = require('path');
var mod_ejs = require('ejs');
var mod_fs = require('fs');

function Notifier(opts) {
	mod_assert.object(opts, 'options');
	mod_assert.object(opts.config, 'options.config');

	mod_assert.optionalObject(opts.log, 'options.log');
	var log = opts.log || mod_bunyan.createLogger({
	    name: 'ufds-terror-alert' });
	this.log = log.child({component: 'Notifier'});
	this.config = opts.config;

	mod_assert.object(opts.db, 'options.db');
	this.db = opts.db;

	mod_assert.object(opts.mailer, 'options.mailer');
	this.mailer = opts.mailer;

	this.tplDir = mod_path.join(__dirname, '..', 'tpl');
	this.tplCache = {};
	this.lastKeyMismatch = undefined;
}

Notifier.prototype.render = function (tpl, args) {
	if (this.tplCache[tpl] === undefined) {
		var fname = mod_path.join(this.tplDir, tpl + '.ejs');
		var text = mod_fs.readFileSync(fname).toString('utf-8');
		this.tplCache[tpl] = mod_ejs.compile(text);
	}
	args.cloud_name = this.config.cloud_name;
	args.company = this.config.company;
	return (this.tplCache[tpl](args));
};

Notifier.prototype.operatorMail = function (subject, text) {
	if (this.config.initialSync)
		return;

	var self = this;
	var mail = {};
	mail.from = this.config.my_email;
	mail.to = this.config.operators;
	mail.subject = this.config.oper_prefix + subject;
	mail.text = text;
	this.mailer.sendMail(mail, function (err, info) {
		if (err) {
			self.log.error(err, 'failed sending operator mail');
			return;
		}
		self.log.info({subject: subject, resp: info.response},
		    'sent mail to operators');
	});
};

Notifier.prototype.userMail = function (to, subject, text) {
	if (this.config.initialSync)
		return;

	var self = this;
	var mail = {};
	mail.from = this.config.my_email;
	mail.to = to;
	mail.subject = this.config.user_prefix + subject;
	mail.text = text;
	this.mailer.sendMail(mail, function (err, info) {
		if (err) {
			self.log.error(err,
			    'failed sending user mail to %j (%s)', to, subject);
			return;
		}
		self.log.info({to: to, subject: subject, resp: info.response},
		    'sent mail to user');
	});
};

Notifier.prototype.ufdsKeyMismatch = function (expectedFp, newKey) {
	var self = this;
	this.db.get('select value from metadata where key = ?',
	    'last_key_mismatch', function (err, row) {
		if (err) {
			self.log.error(err, 'failed reading from db');
			return;
		}
		var last = self.lastKeyMismatch;
		var now = new Date();
		if (row !== undefined)
			last = new Date(row.value);
		self.db.run('insert or replace into metadata (key, value) ' +
		    'values (?, ?)', 'last_key_mismatch', now.toISOString());
		if (last === undefined ||
		    now.getTime() - last.getTime() > 4*3600*1000) {
			var text = self.render('ufds-key-mismatch', {
				expectedFp: expectedFp.toString(),
				newFp: newKey.fingerprint().toString()
			});
			self.operatorMail('UFDS key mismatch', text);
		}
		self.lastKeyMismatch = now;
	});
};

Notifier.prototype.changedLogin =
    function (when, uuid, oldLogin, newLogin, email) {
	var self = this;
	this.db.get('select * from users where uuid = ?', uuid,
	    function (err, row) {
		if (err) {
			self.log.error(err, 'failed reading from db');
			return;
		}
		if (row === undefined) {
			self.log.error('changed login user %s, but they ' +
			    'could not be found in the database', uuid);
			return;
		}
		var disabled = (row.status !== 'active');
		if (!disabled) {
			var text = self.render('changed-login', {
				when: new Date(when),
				uuid: uuid,
				oldLogin: oldLogin,
				newLogin: newLogin,
				email: email
			});
			self.operatorMail('Account ' + oldLogin +
			    ' login name changed', text);
		}
	});
};

Notifier.prototype.changedPassword = function (when, uuid, email) {
	var self = this;
	this.db.get('select * from users where uuid = ?', uuid,
	    function (err, row) {
		if (err) {
			self.log.error(err, 'failed reading from db');
			return;
		}
		if (row === undefined) {
			self.log.error('operator del from user %s, but they ' +
			    'could not be found in the database', uuid);
			return;
		}
		var text = self.render('pw-changed', {
			when: new Date(when),
			uuid: uuid,
			user: row
		});
		var whitelisted = (!self.config.whitelist ||
		    self.config.whitelist.length < 1 ||
		    self.config.whitelist.indexOf(uuid) !== -1);
		var disabled = (row.status !== 'active');
		if (whitelisted && !disabled) {
			self.userMail(row.email,
			    'Your password has been changed', text);
		}
		if (row.operator === 1 || row.reader === 1 ||
		    row.roleoper === 1) {
			text = self.render('oper-pw-changed', {
				when: new Date(when),
				uuid: uuid,
				user: row
			});
			self.operatorMail('Password changed for operator ' +
			    row.login, text);
		}
	});
};

Notifier.prototype.changedEmail = function (when, uuid, oldEmail, newEmail) {
	var self = this;
	this.db.get('select * from users where uuid = ?', uuid,
	    function (err, row) {
		if (err) {
			self.log.error(err, 'failed reading from db');
			return;
		}
		if (row === undefined) {
			self.log.error('email change from user %s, but they ' +
			    'could not be found in the database', uuid);
			return;
		}
		var text = self.render('email-changed', {
			when: new Date(when),
			uuid: uuid,
			oldEmail: oldEmail,
			newEmail: newEmail,
			user: row
		});
		var whitelisted = (!self.config.whitelist ||
		    self.config.whitelist.length < 1 ||
		    self.config.whitelist.indexOf(uuid) !== -1);
		var disabled = (row.status !== 'active');
		if (whitelisted && !disabled) {
			self.userMail([oldEmail, newEmail],
			    'Your email address has been changed', text);
		}
		if (row.operator === 1 || row.reader === 1 ||
		    row.roleoper === 1) {
			text = self.render('oper-email-changed', {
				when: new Date(when),
				uuid: uuid,
				oldEmail: oldEmail,
				newEmail: newEmail,
				user: row
			});
			self.operatorMail('Operator email change for ' +
			    row.login, text);
		}
	});
};

Notifier.prototype.deletedUser = function (when, uuid, user) {
	var self = this;
	if (user.operator === 1 || user.reader === 1 ||
	    user.roleoper === 1) {
		var text = self.render('deleted-operator', {
			when: new Date(when),
			uuid: uuid,
			user: user
		});
		self.operatorMail('Operator account ' +
		    user.login + ' deleted', text);
	}
};

Notifier.prototype.addedKey = function (when, uuid, key, name, otherKeys) {
	var self = this;
	mod_vasync.pipeline({
		funcs: [getUser, findKeys, getOtherUsers, sendMail],
		arg: {}
	}, function (err) {
	});
	function getUser(_, cb) {
		self.db.get('select * from users where uuid = ?', uuid,
		    function (err, row) {
			if (err) {
				self.log.error(err, 'failed reading from db');
				cb(err);
				return;
			}
			if (row === undefined) {
				self.log.error('added key to user %s, but ' +
				    'they could not be found in the database',
				    uuid);
				cb(new Error('Not Found'));
				return;
			}
			_.user = row;
			cb();
		});
	}
	function findKeys(_, cb) {
		self.db.all('select uuid, name, comment from keys ' +
		    ' where fingerprint = ? and uuid != ?',
		    key.fingerprint('md5').toString('hex'), uuid,
		    function (err, rows) {
			if (err) {
				cb(err);
				return;
			}
			_.otherLocations = rows;
			cb();
		});
	}
	function getOtherUsers(_, cb) {
		mod_vasync.forEachPipeline({
			func: fetchOtherUser,
			inputs: _.otherLocations
		}, cb);
		function fetchOtherUser(user, ccb) {
			self.db.get('select * from users where uuid = ?',
			    user.uuid, function (err, row) {
				if (err) {
					ccb(err);
					return;
				}
				user.login = row.login;
				user.email = row.email;
				ccb();
			});
		}
	}
	function sendMail(_, cb) {
		var text = self.render('added-key', {
			when: new Date(when),
			uuid: uuid,
			key: key,
			name: name,
			keys: otherKeys,
			otherLocations: _.otherLocations,
			user: _.user
		});
		var whitelisted = (!self.config.whitelist ||
		    self.config.whitelist.length < 1 ||
		    self.config.whitelist.indexOf(uuid) !== -1);
		var disabled = (_.user.status !== 'active');
		if (whitelisted && !disabled) {
			self.userMail(_.user.email,
			    'New SSH key added to account ' + _.user.login,
			    text);
		}
		if (_.user.operator === 1 || _.user.reader === 1 ||
		    _.user.roleoper === 1) {
			text = self.render('oper-added-key', {
				when: new Date(when),
				uuid: uuid,
				key: key,
				name: name,
				keys: otherKeys,
				user: _.user,
				otherLocations: _.otherLocations
			});
			self.operatorMail('SSH key added to operator ' +
			    _.user.login, text);
		}
		cb();
	}
};

Notifier.prototype.deletedKey = function (when, uuid, key, name, otherKeys) {
	var self = this;
	this.db.get('select * from users where uuid = ?', uuid,
	    function (err, row) {
		if (err) {
			self.log.error(err, 'failed reading from db');
			return;
		}
		if (row === undefined) {
			self.log.error('deleted key from user %s, but they ' +
			    'could not be found in the database', uuid);
			return;
		}
		var text = self.render('deleted-key', {
			when: new Date(when),
			uuid: uuid,
			key: key,
			name: name,
			keys: otherKeys,
			user: row
		});
		var whitelisted = (!self.config.whitelist ||
		    self.config.whitelist.length < 1 ||
		    self.config.whitelist.indexOf(uuid) !== -1);
		var disabled = (row.status !== 'active');
		if (whitelisted && !disabled) {
			self.userMail(row.email,
			    'SSH key deleted from account ' + row.login, text);
		}
		if (row.operator === 1 || row.reader === 1 ||
		    row.roleoper === 1) {
			text = self.render('oper-deleted-key', {
				when: new Date(when),
				uuid: uuid,
				key: key,
				name: name,
				keys: otherKeys,
				user: row
			});
			self.operatorMail('SSH key deleted from operator ' +
			    row.login, text);
		}
	});
};

Notifier.prototype.operatorAdded = function (when, uuid, group) {
	if (group === undefined)
		group = 'operator';
	var self = this;
	this.db.get('select * from users where uuid = ?', uuid,
	    function (err, row) {
		if (err) {
			self.log.error(err, 'failed reading from db');
			return;
		}
		if (row === undefined) {
			self.log.error('operator add from user %s, but they ' +
			    'could not be found in the database', uuid);
			return;
		}
		self.db.all('select * from keys where uuid = ?', uuid,
		    function (s_err, rows) {
			var text = self.render('new-operator', {
				when: new Date(when),
				uuid: uuid,
				user: row,
				group: group,
				keys: rows
			});
			self.operatorMail('New operator account ' +
			    row.login, text);
		});
	});
};

Notifier.prototype.weirdGroupMemberAdded = function (when, dn, group, err) {
	if (group === undefined)
		group = 'operators';
	var self = this;
	var text = self.render('new-weird-group-member', {
		when: new Date(when),
		group: group,
		dn: dn,
		err: err
	});
	self.operatorMail('Unknown DN added to group ' + group, text);
};

Notifier.prototype.weirdGroupMemberRemoved = function (when, dn, group, err) {
	if (group === undefined)
		group = 'operators';
	var self = this;
	var text = self.render('deleted-weird-group-member', {
		when: new Date(when),
		group: group,
		dn: dn,
		err: err
	});
	self.operatorMail('Unknown DN removed from group ' + group, text);
};

Notifier.prototype.readerAdded = function (when, uuid) {
	this.operatorAdded(when, uuid, 'reader');
};

Notifier.prototype.roleoperAdded = function (when, uuid) {
	this.operatorAdded(when, uuid, 'role-operator');
};

Notifier.prototype.operatorRemoved = function (when, uuid, group) {
	if (group === undefined)
		group = 'operator';
	var self = this;
	this.db.get('select * from users where uuid = ?', uuid,
	    function (err, row) {
		if (err) {
			self.log.error(err, 'failed reading from db');
			return;
		}
		if (row === undefined) {
			self.log.error('operator del from user %s, but they ' +
			    'could not be found in the database', uuid);
			return;
		}
		var text = self.render('deleted-operator', {
			when: new Date(when),
			uuid: uuid,
			user: row,
			group: group
		});
		self.operatorMail('Demoted operator account ' +
		    row.login, text);
	});
};

Notifier.prototype.readerRemoved = function (when, uuid) {
	this.operatorRemoved(when, uuid, 'reader');
};

Notifier.prototype.roleoperRemoved = function (when, uuid) {
	this.operatorRemoved(when, uuid, 'role-operator');
};
