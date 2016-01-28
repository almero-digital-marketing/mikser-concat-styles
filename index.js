'use strict'
let Promise = require('bluebird')
let path = require('path');
let fs = require('fs-extra-promise');
let postcss = require("postcss");
let atImport = require("postcss-import");
let url = require("postcss-url");

module.exports = function (mikser, context) {

	function rebase (style, info) {
		return fs.readFileAsync(style).then((content) => {
			return postcss()
				.use(url({
					url: "rebase"
				}))
				.process(content, {
					from: mikser.manager.getUrl(style),
					to: mikser.manager.getUrl(info.destination)
				}).then((result) => {
					return Promise.resolve(result.css);
				});
		});
	}

	context.concatStyles = function (sources, destination, sourcemap) {

		if (!sources) {
			let err = new Error('Undefined source list');
			err.origin = 'concat';
			throw err;
		}

		if (!Array.isArray(sources)) sources = [sources];
		let share = mikser.manager.getShare(context.document.destination);
		sources.forEach((source, index, arr) => {
			if (share){
				arr[index] = path.join(mikser.config.outputFolder, share, source);
			}
			else {
				arr[index] = path.join(mikser.config.outputFolder, source);
			}
		});

		if (!destination) {
			let err = new Error('Undefined destination');
			err.origin = 'concat';
			throw err;
		}

		let concatInfo = {
			sourceExt: '.css',
			destinationExt: path.extname(destination),
			generateSourceMap: sourcemap === true ? sourcemap : false,
		}
		concatInfo.destination = concatInfo.sourceExt === concatInfo.destinationExt ? path.join(mikser.config.outputFolder, destination) : path.join(mikser.config.outputFolder, destination, path.basename(context.layouts[0]._id, path.extname(context.layouts[0]._id)) + '.all' + concatInfo.sourceExt);
		concatInfo.outDir = path.dirname(concatInfo.destination);

		context.pending = context.pending.then(() => {
			if (mikser.manager.isNewer(sources, concatInfo.destination)) {
				let importContent = '';
				return Promise.map(sources, (style) => {
					return rebase(style, concatInfo);
				}).then((rebasedStyles) => {
					sources.forEach((style, index) => {
						importContent += '@import "' + style + (index === sources.length -1 ? '";' : '";\n');
					});
					return postcss(atImport({
						root: mikser.config.outputFolder,
						load: (fileName) => {
							return rebase(fileName, concatInfo);
						}
					}))
					.process(importContent, {
						from: mikser.config.outputFolder,
						to: concatInfo.destination,
						map: concatInfo.generateSourceMap === true ? { inline: true } : false
					}).then((output) => {
						return fs.outputFileAsync(concatInfo.destination, output.css);
					});
				});
			} else {
				return Promise.resolve();
			}
		});
		return mikser.manager.getUrl(concatInfo.destination);
		
	}
}